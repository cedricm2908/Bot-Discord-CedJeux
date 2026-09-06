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
// EXCLU de ce lot (LOT 2), volontairement : sell. Elle mute a la fois le
// joueur ET l'etat global (contract.remaining) -- elle a besoin de la
// meme primitive que harvest ci-dessous (mutatePlayerAndGlobal()), pas
// encore branchee pour sell a ce stade (LOT 6, wiring /harvest).
//
// LOT 6 (wiring /harvest) : harvestPlayerCrops() ci-dessous est la
// PREMIERE action de ce fichier a utiliser mutatePlayerAndGlobal() plutot
// que mutatePlayer() -- necessaire car harvest() (../farm.ts) mute a la
// fois le joueur (inventaire/xp/niveau/parcelles) ET l'etat global
// (daily_challenge.progress/contributors), verrouilles ensemble dans UNE
// seule transaction (voir le commentaire de mutatePlayerAndGlobal() dans
// farmRepository.ts, qui documente explicitement harvest()/sell() comme
// compatibles SANS adaptation).
//
// GLOBAL STATE : buyPlayerWeatherForecast() lit global_state en LECTURE
// SEULE (via getGlobalState(), jamais ecrit) ; harvestPlayerCrops() le
// verrouille et l'ecrit (via mutatePlayerAndGlobal()) -- ce sont les deux
// SEULES actions de ce fichier qui touchent global_state.
import {
  buyUpgrade,
  buyWeatherForecast,
  chooseSkin,
  claimDaily,
  claimQuest,
  craft,
  FarmError,
  harvest,
  plant,
  toggleAutoReplant,
  type HarvestResult,
} from "../farm.ts";
import { getGlobalState, mutatePlayer, mutatePlayerAndGlobal } from "./farmRepository.ts";
import type { CropId, GlobalState, PlayerState, PlotSkinId, ProductId, WeatherKey } from "../types";

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

// Dependances injectables dediees a harvestPlayerCrops() -- separees de
// FarmPlayerActionsDeps (qui n'expose que mutatePlayer/getGlobalState) car
// harvest() a besoin de mutatePlayerAndGlobal(), jamais de mutatePlayer()
// seul (voir le commentaire d'en-tete de ce fichier).
export interface HarvestPlayerActionsDeps {
  mutatePlayerAndGlobal: typeof mutatePlayerAndGlobal;
}

const realHarvestPlayerActionsDeps: HarvestPlayerActionsDeps = { mutatePlayerAndGlobal };

/**
 * Recolte toutes les parcelles pretes. Reutilise harvest() de ../farm.ts
 * telle quelle -- y compris son increment d'inventaire/xp/niveau/
 * totalHarvested, sa progression du defi quotidien (daily_challenge.progress/
 * contributors/completed) et sa replantation automatique, deja tous
 * integres a harvest() lui-meme (aucun second systeme n'est introduit
 * ici). `mutatePlayerAndGlobal()` verrouille le joueur ET l'etat global
 * (global_state + contract + daily_challenge) dans UNE SEULE transaction --
 * necessaire car harvest() mute les deux a la fois. Retourne a la fois le
 * `HarvestResult` (pour la reponse Discord) ET le `GlobalState` complet
 * relu/mute (pour que l'appelant puisse afficher la meteo EXACTEMENT comme
 * celle utilisee pour calculer le rendement -- jamais une lecture separee
 * d'un autre etat global qui pourrait diverger). Erreurs metier propagees
 * telles quelles (aucune parcelle prete => harvested vide, verifie par
 * l'appelant, pas ici -- meme repartition des responsabilites qu'en V1 ou
 * ce controle vit dans presenters.ts, pas dans harvest()).
 */
export async function harvestPlayerCrops(
  playerId: string,
  deps: HarvestPlayerActionsDeps = realHarvestPlayerActionsDeps,
): Promise<{ result: HarvestResult; global: GlobalState }> {
  let result: HarvestResult | undefined;
  const { global } = await deps.mutatePlayerAndGlobal(playerId, (player, global) => {
    result = harvest(player, global);
  });
  return { result: result!, global };
}
