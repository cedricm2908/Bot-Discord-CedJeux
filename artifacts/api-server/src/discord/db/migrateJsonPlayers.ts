// LOT V2-POSTGRES-ALL-USERS -- importeur JSON V1 -> PostgreSQL V2.
//
// NE PAS EXECUTER CONTRE UNE VRAIE BASE DANS CE LOT (voir mission section
// 13) : ce fichier fournit uniquement le CORE testable
// (importJsonPlayers(), pur vis-a-vis de ses dependances injectees) et le
// point d'entree CLI reel (main(), jamais appele par les tests). Le
// dry-run reel necessite deja une connexion Postgres (pour savoir quels
// joueurs existent deja) -- non lance ici, seulement teste contre des
// fixtures (voir migrateJsonPlayers.test.ts).
//
// GARANTIES :
// - IDEMPOTENT : un joueur deja present en PostgreSQL (deps.getPlayer()
//   retourne non-null) est TOUJOURS SKIP, jamais ecrase -- relancer
//   l'import plusieurs fois ne fait jamais regresser un joueur deja
//   migre/deja joue en V2.
// - TRANSACTIONNEL PAR JOUEUR : reutilise ensurePlayerExists() (cree la
//   ligne + parcelles avec les defaults V2) PUIS UNE SEULE
//   mutatePlayer() (verrou de ligne, meme primitive que toutes les
//   actions joueur reelles) pour ecraser les valeurs issues du JSON --
//   aucune nouvelle primitive DB, aucune regle metier reimplementee.
// - SANS DELETE, SANS OVERWRITE PAR DEFAUT : la seule ecriture est
//   l'insertion d'un joueur qui n'existait pas encore.
// - DRY-RUN CAPABLE : `options.dryRun === true` ne fait AUCUN appel a
//   deps.ensurePlayerExists/deps.mutatePlayer, uniquement des lectures
//   (deps.getPlayer) pour compter ce qui SERAIT importe.
//
// AUCUN LOG de cette fonction n'affiche un Discord ID complet ou une
// donnee joueur sensible -- le CLI (main(), plus bas) suit la meme regle.
import { CROPS, PLOT_SKINS } from "../constants.ts";
import type { PlayerState } from "../types";
import { ensurePlayerExists, getPlayer, mutatePlayer } from "./farmRepository.ts";

export interface JsonPlayerImportOptions {
  dryRun: boolean;
}

export interface JsonPlayerImportDeps {
  getPlayer: typeof getPlayer;
  ensurePlayerExists: typeof ensurePlayerExists;
  mutatePlayer: typeof mutatePlayer;
}

const realJsonPlayerImportDeps: JsonPlayerImportDeps = { getPlayer, ensurePlayerExists, mutatePlayer };

export interface JsonPlayerImportSummary {
  totalJsonPlayers: number;
  alreadyInPostgres: number;
  wouldImport: number;
  imported: number;
  incompatibilities: string[];
}

const KNOWN_CROP_IDS = new Set(CROPS.map((crop) => crop.id));
const KNOWN_SKIN_IDS = new Set(Object.keys(PLOT_SKINS));

// Detecte des incompatibilites de DONNEES (jamais bloquantes : un joueur
// avec une incompatibilite est quand meme importe, avec la valeur
// suspecte laissee telle quelle -- signaler, jamais corriger
// silencieusement une donnee reelle de joueur). Le libelle ne contient
// JAMAIS le Discord ID complet, seulement son INDEX dans le lot importe.
function detectIncompatibilities(jsonPlayer: PlayerState, index: number): string[] {
  const issues: string[] = [];
  for (const plot of jsonPlayer.plots) {
    if (plot.cropId && !KNOWN_CROP_IDS.has(plot.cropId)) {
      issues.push(`joueur #${index} : parcelle plantee avec une culture inconnue ("${plot.cropId}")`);
    }
  }
  for (const itemId of Object.keys(jsonPlayer.inventory)) {
    if (!KNOWN_CROP_IDS.has(itemId as never) && !itemId.match(/^(bread|pumpkin_pie|sugar_syrup)$/)) {
      issues.push(`joueur #${index} : item d'inventaire inconnu ("${itemId}")`);
    }
  }
  if (jsonPlayer.plotSkin && !KNOWN_SKIN_IDS.has(jsonPlayer.plotSkin)) {
    issues.push(`joueur #${index} : theme de parcelle inconnu ("${jsonPlayer.plotSkin}")`);
  }
  return issues;
}

/**
 * Importe une liste de PlayerState JSON (deja migres vers le schema V2 par
 * FarmStore.init()/migratePlayer() -- voir store.ts, reutilise tel quel,
 * aucune re-implementation de la logique de migration de champs ici) vers
 * PostgreSQL. `jsonPlayers` est fourni par l'appelant (jamais lu depuis le
 * disque ici) pour rester testable avec des fixtures.
 */
export async function importJsonPlayers(
  jsonPlayers: readonly PlayerState[],
  options: JsonPlayerImportOptions,
  deps: JsonPlayerImportDeps = realJsonPlayerImportDeps,
): Promise<JsonPlayerImportSummary> {
  const summary: JsonPlayerImportSummary = {
    totalJsonPlayers: jsonPlayers.length,
    alreadyInPostgres: 0,
    wouldImport: 0,
    imported: 0,
    incompatibilities: [],
  };

  for (const [index, jsonPlayer] of jsonPlayers.entries()) {
    summary.incompatibilities.push(...detectIncompatibilities(jsonPlayer, index));

    const existing = await deps.getPlayer(jsonPlayer.userId);
    if (existing) {
      summary.alreadyInPostgres += 1;
      continue;
    }

    if (options.dryRun) {
      summary.wouldImport += 1;
      continue;
    }

    await deps.ensurePlayerExists(jsonPlayer.userId);
    await deps.mutatePlayer(jsonPlayer.userId, (player) => {
      player.coins = jsonPlayer.coins;
      player.level = jsonPlayer.level;
      player.xp = jsonPlayer.xp;
      player.plots = jsonPlayer.plots.map((plot) => ({ ...plot }));
      player.inventory = { ...jsonPlayer.inventory };
      player.irrigationLevel = jsonPlayer.irrigationLevel;
      player.fertilizerLevel = jsonPlayer.fertilizerLevel;
      player.lastDailyAt = jsonPlayer.lastDailyAt;
      player.autoReplant = jsonPlayer.autoReplant;
      player.weeklySnapshotCoins = jsonPlayer.weeklySnapshotCoins;
      player.totalHarvested = jsonPlayer.totalHarvested;
      player.quests = jsonPlayer.quests.map((quest) => ({ ...quest }));
      player.questsResetAt = jsonPlayer.questsResetAt;
      player.plotSkin = jsonPlayer.plotSkin;
      player.unlockedSkins = [...jsonPlayer.unlockedSkins];
      player.weatherForecast = jsonPlayer.weatherForecast;
    });
    summary.imported += 1;
  }

  return summary;
}

// ===========================================================================
// CLI reel -- JAMAIS appele par les tests (voir migrateJsonPlayers.test.ts,
// qui teste uniquement importJsonPlayers() ci-dessus avec des fixtures et
// des deps injectees). NE PAS lancer ce script contre Neon TEST dans ce
// LOT (mission section 13) -- commande exacte documentee dans le rapport
// final, a executer par l'utilisateur lui-meme quand il le decide.
// ===========================================================================

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun) {
    // Securite supplementaire : ce script ne doit jamais ecrire pour de
    // vrai sans une confirmation explicite ET distincte du simple
    // lancement de la commande -- evite un import reel accidentel.
    if (!process.argv.includes("--confirm-real-import")) {
      console.error(
        "Refus : lancer un import reel necessite --dry-run OU --confirm-real-import explicitement. Aucune ecriture effectuee.",
      );
      process.exitCode = 1;
      return;
    }
  }

  // Reutilise FarmStore (store.ts) pour la lecture JSON -- aucune
  // re-implementation du parsing/de la migration de champs V1->V2.
  const { FarmStore } = await import("../store.ts");
  const store = new FarmStore();
  await store.init();
  const jsonPlayers = store.getPlayers();

  const summary = await importJsonPlayers(jsonPlayers, { dryRun });

  // AUCUN Discord ID, AUCUNE donnee joueur : uniquement des compteurs.
  console.log(`Joueurs JSON trouves       : ${summary.totalJsonPlayers}`);
  console.log(`Deja presents en Postgres  : ${summary.alreadyInPostgres}`);
  if (dryRun) {
    console.log(`Seraient importes (dry-run): ${summary.wouldImport}`);
  } else {
    console.log(`Importes                   : ${summary.imported}`);
  }
  if (summary.incompatibilities.length > 0) {
    console.log(`Incompatibilites detectees : ${summary.incompatibilities.length}`);
    for (const issue of summary.incompatibilities) console.log(`  - ${issue}`);
  }
}

// N'execute main() QUE si ce fichier est lance directement (tsx
// src/discord/db/migrateJsonPlayers.ts), jamais quand il est importe par
// les tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
