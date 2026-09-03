// Couche d'ACTIONS JOUEUR PostgreSQL pour les mutations simples du LOT 2
// du plan de migration Farm2Win. Independante de Discord (aucun import
// discord.js/express) et independante de FarmStore/JSON (aucun import de
// ./store ou ./sharedStore) -- chaque action se contente d'orchestrer
// mutatePlayer() (deja valide en concurrence reelle, voir
// testMutatePlayerConcurrency.ts) et la fonction metier V1 PURE
// correspondante de ../farm.ts. Aucune regle Farm2Win n'est dupliquee ou
// reecrite ici : chaque action appelle exactement la meme fonction que
// presenters.ts/routes/activity.ts appellent aujourd'hui contre FarmStore.
//
// EXCLUS de ce lot (LOT 2), volontairement : harvest et sell. Elles mutent
// a la fois le joueur ET l'etat global (contract.remaining pour sell,
// daily_challenge.progress/contributors pour harvest) -- elles ont besoin
// d'une primitive qui verrouille les DEUX ressources dans UNE seule
// transaction (mutatePlayerAndGlobal(), categorie E de l'audit de
// migration), qui n'existe pas encore et n'est pas creee ici.
//
// GLOBAL STATE : une seule action de ce fichier lit global_state
// (buyPlayerWeatherForecast, via getGlobalState()) -- buyWeatherForecast()
// ne fait que LIRE global.nextWeatherType, jamais l'ecrire. Aucune autre
// action de ce fichier ne touche global_state, et aucune ecriture globale
// n'a lieu nulle part dans ce fichier (ni mutateGlobalState(), qui
// n'existe pas encore, ni un UPDATE direct quelconque).
import {
  buyUpgrade,
  buyWeatherForecast,
  chooseSkin,
  claimDaily,
  claimQuest,
  craft,
  FarmError,
  plant,
  toggleAutoReplant,
} from "../farm.ts";
import { getGlobalState, mutatePlayer } from "./farmRepository.ts";
import type { CropId, PlayerState, PlotSkinId, ProductId, WeatherKey } from "../types";

// Dependances injectables -- meme convention que FarmRepositoryDeps/
// PlayerWriteDeps/MutatePlayerDeps dans farmRepository.ts : les tests
// mockent mutatePlayer/getGlobalState sans jamais toucher a
// @workspace/db ou a une connexion reelle.
export interface FarmPlayerActionsDeps {
  mutatePlayer: typeof mutatePlayer;
  getGlobalState: typeof getGlobalState;
}

const realFarmPlayerActionsDeps: FarmPlayerActionsDeps = { mutatePlayer, getGlobalState };

/**
 * Plante une culture sur une parcelle. Reutilise plant() de ../farm.ts
 * telle quelle -- y compris son reset paresseux des quetes deja integre
 * (resetQuestsIfNeeded(), appele par plant() lui-meme : aucun second
 * systeme de reset n'est introduit ici). Retourne le numero de parcelle
 * plantee (1-indexe), identique a ce que plant() retourne deja en V1.
 * Erreurs metier propagees telles quelles (culture non debloquee, pieces
 * insuffisantes, parcelle invalide/occupee).
 */
export async function plantPlayerCrop(
  playerId: string,
  cropId: CropId,
  requestedPlot: number | null,
  deps: FarmPlayerActionsDeps = realFarmPlayerActionsDeps,
): Promise<number> {
  let plantedPlot = 0;
  await deps.mutatePlayer(playerId, (player) => {
    plantedPlot = plant(player, cropId, requestedPlot);
  });
  return plantedPlot;
}

/**
 * Achete des ameliorations (parcelles/irrigation/engrais). Reutilise
 * buyUpgrade() telle quelle. Erreurs metier propagees telles quelles
 * (quantite hors bornes, niveau maximum atteint, pieces insuffisantes).
 */
export async function buyPlayerUpgrade(
  playerId: string,
  kind: "plots" | "irrigation" | "fertilizer",
  quantity: number,
  deps: FarmPlayerActionsDeps = realFarmPlayerActionsDeps,
): Promise<{ bought: number; spent: number }> {
  let result: { bought: number; spent: number } | undefined;
  await deps.mutatePlayer(playerId, (player) => {
    result = buyUpgrade(player, kind, quantity);
  });
  return result!;
}

/**
 * Fabrique un produit transforme a partir de cultures recoltees. Reutilise
 * craft() telle quelle. Erreurs metier propagees telles quelles (quantite
 * hors bornes, ingredients insuffisants).
 */
export async function craftPlayerItem(
  playerId: string,
  recipeId: ProductId,
  quantity: number,
  deps: FarmPlayerActionsDeps = realFarmPlayerActionsDeps,
): Promise<number> {
  let crafted = 0;
  await deps.mutatePlayer(playerId, (player) => {
    crafted = craft(player, recipeId, quantity);
  });
  return crafted;
}

/**
 * Reclame la recompense quotidienne. Reutilise claimDaily() telle quelle
 * -- le cooldown (20h) est porte par player.lastDailyAt sur la ligne
 * joueur elle-meme, deja protege contre deux reclamations concurrentes du
 * MEME joueur par le verrou de ligne pose par mutatePlayer() (SELECT ...
 * FOR UPDATE) : aucun ledger reward_claims separe n'est necessaire pour
 * cette action. Erreur metier propagee telle quelle (cooldown actif).
 */
export async function claimPlayerDaily(
  playerId: string,
  deps: FarmPlayerActionsDeps = realFarmPlayerActionsDeps,
): Promise<number> {
  let reward = 0;
  await deps.mutatePlayer(playerId, (player) => {
    reward = claimDaily(player);
  });
  return reward;
}

/**
 * Reclame la recompense d'une quete terminee. Reutilise claimQuest() telle
 * quelle. Erreurs metier propagees telles quelles (quete inexistante,
 * deja reclamee, pas encore terminee).
 */
export async function claimPlayerQuest(
  playerId: string,
  questIndex: number,
  deps: FarmPlayerActionsDeps = realFarmPlayerActionsDeps,
): Promise<number> {
  let reward = 0;
  await deps.mutatePlayer(playerId, (player) => {
    reward = claimQuest(player, questIndex);
  });
  return reward;
}

/**
 * Choisit un theme de parcelle debloque. Reutilise chooseSkin() telle
 * quelle -- cette fonction metier ne retourne rien (void), donc l'etat
 * joueur complet apres mutation (deja produit par mutatePlayer(), aucune
 * relecture supplementaire) sert de resultat exploitable par les futurs
 * handlers. Erreurs metier propagees telles quelles (theme inexistant,
 * niveau insuffisant).
 */
export async function choosePlayerSkin(
  playerId: string,
  skinId: PlotSkinId,
  deps: FarmPlayerActionsDeps = realFarmPlayerActionsDeps,
): Promise<PlayerState> {
  return deps.mutatePlayer(playerId, (player) => {
    chooseSkin(player, skinId);
  });
}

/**
 * Bascule la replantation automatique. Aucune fonction metier pure
 * dediee n'existait en V1 (le flag etait bascule directement dans les
 * couches Discord/Activity, via `player.autoReplant = !player.autoReplant`
 * dans presenters.ts et routes/activity.ts) -- toggleAutoReplant() a ete
 * ajoutee a ../farm.ts pour porter cette regle triviale sans la dupliquer
 * ici ni coder une regle metier directement dans cette couche DB. Retourne
 * la nouvelle valeur du flag.
 */
export async function togglePlayerAutoReplant(
  playerId: string,
  deps: FarmPlayerActionsDeps = realFarmPlayerActionsDeps,
): Promise<boolean> {
  let autoReplant = false;
  await deps.mutatePlayer(playerId, (player) => {
    autoReplant = toggleAutoReplant(player);
  });
  return autoReplant;
}

/**
 * Achete une prevision meteo. buyWeatherForecast() a besoin de LIRE
 * global.nextWeatherType mais ne le modifie jamais -- global_state est
 * donc lu via getGlobalState() UNE FOIS, AVANT d'ouvrir la transaction
 * joueur, jamais verrouille ni ecrit (aucun mutateGlobalState(), qui
 * n'existe pas encore et n'est pas necessaire ici). Si global_state est
 * absent (base non encore seedee), leve une FarmError explicite plutot
 * qu'une erreur technique opaque -- ce n'est pas une nouvelle regle de
 * jeu, seulement une garde technique sur une precondition que FarmStore
 * garantissait deja par construction (auto-creation au demarrage) et que
 * Postgres ne garantit pas.
 */
export async function buyPlayerWeatherForecast(
  playerId: string,
  deps: FarmPlayerActionsDeps = realFarmPlayerActionsDeps,
): Promise<WeatherKey> {
  const global = await deps.getGlobalState();
  if (!global) {
    throw new FarmError("L'état global du jeu est introuvable pour le moment.");
  }
  let forecast: WeatherKey | undefined;
  await deps.mutatePlayer(playerId, (player) => {
    forecast = buyWeatherForecast(player, global);
  });
  return forecast!;
}
