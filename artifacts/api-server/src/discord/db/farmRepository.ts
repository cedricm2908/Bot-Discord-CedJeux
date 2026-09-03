// Premiere couche de repository PostgreSQL pour le gameplay Farm2Win.
// LECTURE SEULE dans cette version : aucun INSERT/UPDATE/DELETE, aucune
// transaction. Pas encore branche sur le bot/les slash commands.
//
// Les types metier canoniques (PlayerState, GlobalState) restent ceux de
// V1/api-server (../types) -- @workspace/db ne retourne que des DTO bruts
// (PlayerRecord/GlobalStateRecord). La conversion passe par les adaptateurs
// deja existants (playerAdapter.ts/globalStateAdapter.ts), jamais dupliquee
// ici.
//
// Architecture testable sans connexion DB : `createFarmRepository(deps)` est
// une factory PURE qui ne touche jamais @workspace/db elle-meme -- toutes ses
// dependances (lecture DB + adaptateurs) lui sont injectees. Les tests
// n'appellent que cette factory avec des mocks.
//
// Les exports getPlayer/getAllPlayers/getGlobalState ci-dessous sont la
// version "reelle" (celle qu'un futur branchement utiliserait) : ils
// importent @workspace/db/repositories de facon DYNAMIQUE, uniquement au
// moment de l'appel -- pas au chargement du module. Un import statique
// declencherait immediatement la verification DATABASE_URL de
// lib/db/src/index.ts des le chargement de ce fichier (donc aussi pendant
// les tests), ce que ce fichier evite deliberement.
import { eq, sql } from "drizzle-orm";
import { toGlobalState } from "./globalStateAdapter.ts";
import { toPlayerState } from "./playerAdapter.ts";
import type { GlobalState, PlayerState } from "../types";
import type { GlobalStateRecord, PlayerRecord } from "@workspace/db/repositories";
import type { db as DbInstance, NewInventoryItem, NewPlayer, NewPlot, Player } from "@workspace/db";

export interface FarmRepositoryDeps {
  getPlayerRecord: (playerId: string) => Promise<PlayerRecord | null>;
  getAllPlayerRecords: () => Promise<PlayerRecord[]>;
  getGlobalStateRecord: () => Promise<GlobalStateRecord | null>;
  toPlayerState: (record: PlayerRecord) => PlayerState;
  toGlobalState: (record: GlobalStateRecord) => GlobalState;
}

export interface FarmRepository {
  getPlayer(playerId: string): Promise<PlayerState | null>;
  getAllPlayers(): Promise<PlayerState[]>;
  getGlobalState(): Promise<GlobalState | null>;
}

export function createFarmRepository(deps: FarmRepositoryDeps): FarmRepository {
  return {
    async getPlayer(playerId) {
      const record = await deps.getPlayerRecord(playerId);
      return record ? deps.toPlayerState(record) : null;
    },
    async getAllPlayers() {
      const records = await deps.getAllPlayerRecords();
      return records.map((record) => deps.toPlayerState(record));
    },
    async getGlobalState() {
      const record = await deps.getGlobalStateRecord();
      return record ? deps.toGlobalState(record) : null;
    },
  };
}

async function getRealDeps(): Promise<FarmRepositoryDeps> {
  const { getPlayerRecord, getAllPlayerRecords, getGlobalStateRecord } = await import(
    "@workspace/db/repositories"
  );
  return { getPlayerRecord, getAllPlayerRecords, getGlobalStateRecord, toPlayerState, toGlobalState };
}

export async function getPlayer(playerId: string): Promise<PlayerState | null> {
  const deps = await getRealDeps();
  return createFarmRepository(deps).getPlayer(playerId);
}

export async function getAllPlayers(): Promise<PlayerState[]> {
  const deps = await getRealDeps();
  return createFarmRepository(deps).getAllPlayers();
}

export async function getGlobalState(): Promise<GlobalState | null> {
  const deps = await getRealDeps();
  return createFarmRepository(deps).getGlobalState();
}

// ===========================================================================
// ECRITURE : savePlayerWithTx / savePlayer
// ===========================================================================
//
// IMPORTANT (precision de concurrence) : savePlayerWithTx garantit l'atomicite
// de l'ecriture multi-table (players + plots + inventory_items) et serialise
// les transactions concurrentes ciblant le MEME joueur via SELECT ... FOR
// UPDATE. Cela NE garantit PAS a lui seul l'absence de lost update si le
// PlayerState fourni a ete lu/mute avant l'ouverture de CETTE transaction --
// un appelant qui ferait `getPlayer()` (hors transaction), mute l'objet, puis
// appelle `savePlayer()` plus tard reste expose a ce qu'un autre appel
// concurrent ecrase son resultat. La garantie complete anti-lost-update
// viendra de la future `mutatePlayer()` : BEGIN -> SELECT ... FOR UPDATE ->
// reconstruction PlayerState -> mutation metier -> savePlayerWithTx(...) ->
// COMMIT, le tout dans UNE SEULE transaction ouverte de bout en bout.
// savePlayerWithTx/savePlayer ne doivent donc pas encore etre branches sur
// des commandes concurrentes.
//
// Type du parametre `tx` : derive mecaniquement du type reel de
// `db.transaction` (via `import type { db }`, efface a la compilation --
// aucun import runtime de @workspace/db ici) plutot que reconstruit a la
// main, pour rester exact meme si la version de drizzle-orm change.
type Tx = Parameters<typeof DbInstance.transaction>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;

export interface PlayerWriteDeps {
  lockAndGetPlayer: (tx: Tx, playerId: string) => Promise<Player | null>;
  updatePlayerRow: (tx: Tx, playerId: string, values: Omit<NewPlayer, "id" | "createdAt">) => Promise<void>;
  upsertPlots: (tx: Tx, rows: NewPlot[]) => Promise<void>;
  upsertInventoryItems: (tx: Tx, rows: NewInventoryItem[]) => Promise<void>;
}

// Les tables (players/plots/inventoryItems) sont importees DYNAMIQUEMENT,
// uniquement au premier appel reel -- pas au chargement du module. Raison
// concrete (pas seulement DATABASE_URL cette fois) : lib/db/src/schema/index.ts
// reexporte ses fichiers via des chemins sans extension ("./players"), une
// convention qui suppose un resolveur "bundler" (tsx, tsc) -- le resolveur
// ESM natif de Node (--experimental-strip-types, utilise par `pnpm test`)
// ne la supporte pas et echoue au chargement. Importer dynamiquement evite
// que le simple fait d'importer farmRepository.ts (y compris dans les
// tests, qui ne mockent que PlayerWriteDeps) ne declenche cette resolution.
let schemaTablesPromise: Promise<{
  players: typeof import("@workspace/db/schema").players;
  plots: typeof import("@workspace/db/schema").plots;
  inventoryItems: typeof import("@workspace/db/schema").inventoryItems;
}> | null = null;

function getSchemaTables() {
  schemaTablesPromise ??= import("@workspace/db/schema");
  return schemaTablesPromise;
}

async function realLockAndGetPlayer(tx: Tx, playerId: string): Promise<Player | null> {
  const { players } = await getSchemaTables();
  const [row] = await tx.select().from(players).where(eq(players.id, playerId)).for("update");
  return row ?? null;
}

async function realUpdatePlayerRow(
  tx: Tx,
  playerId: string,
  values: Omit<NewPlayer, "id" | "createdAt">,
): Promise<void> {
  const { players } = await getSchemaTables();
  await tx.update(players).set(values).where(eq(players.id, playerId));
}

async function realUpsertPlots(tx: Tx, rows: NewPlot[]): Promise<void> {
  if (rows.length === 0) return;
  const { plots } = await getSchemaTables();
  await tx.insert(plots).values(rows).onConflictDoUpdate({
    target: [plots.playerId, plots.plotIndex],
    // Reference la valeur soumise pour CHAQUE ligne du lot (pas une valeur
    // fixe) -- necessaire pour un upsert par lot avec des valeurs qui
    // different d'une ligne a l'autre. Voir doc Drizzle "upsert multiple rows".
    set: {
      cropId: sql.raw(`excluded.${plots.cropId.name}`),
      plantedAt: sql.raw(`excluded.${plots.plantedAt.name}`),
      notifiedReady: sql.raw(`excluded.${plots.notifiedReady.name}`),
    },
  });
}

async function realUpsertInventoryItems(tx: Tx, rows: NewInventoryItem[]): Promise<void> {
  if (rows.length === 0) return;
  const { inventoryItems } = await getSchemaTables();
  await tx.insert(inventoryItems).values(rows).onConflictDoUpdate({
    target: [inventoryItems.playerId, inventoryItems.itemId],
    set: { quantity: sql.raw(`excluded.${inventoryItems.quantity.name}`) },
  });
}

const realPlayerWriteDeps: PlayerWriteDeps = {
  lockAndGetPlayer: realLockAndGetPlayer,
  updatePlayerRow: realUpdatePlayerRow,
  upsertPlots: realUpsertPlots,
  upsertInventoryItems: realUpsertInventoryItems,
};

/**
 * Sauvegarde l'etat complet d'un joueur EXISTANT. Suppose une transaction
 * deja ouverte (tx) -- ne l'ouvre pas, ne la commit pas, ne la rollback pas
 * elle-meme (delegue entierement a Drizzle : toute exception ici remonte a
 * l'appelant, qui doit etre dans un db.transaction()).
 *
 * - Verrouille et verifie l'existence du joueur (SELECT ... FOR UPDATE).
 *   Absent -> erreur, AUCUNE ecriture n'est tentee ensuite.
 * - UPDATE cible de players (jamais de suppression/recreation du joueur).
 * - Upsert par lot des plots, cle (player_id, plot_index) -- jamais de DELETE.
 * - Upsert par lot de inventory_items, cle (player_id, item_id) -- une
 *   quantite de 0 reste une ligne valide (n'est jamais retiree).
 */
export async function savePlayerWithTx(
  tx: Tx,
  playerState: PlayerState,
  deps: PlayerWriteDeps = realPlayerWriteDeps,
): Promise<void> {
  const existing = await deps.lockAndGetPlayer(tx, playerState.userId);
  if (!existing) {
    throw new Error(
      `savePlayerWithTx : joueur "${playerState.userId}" introuvable -- aucune creation automatique, aucune ecriture effectuee.`,
    );
  }

  await deps.updatePlayerRow(tx, playerState.userId, {
    coins: playerState.coins,
    level: playerState.level,
    xp: playerState.xp,
    irrigationLevel: playerState.irrigationLevel,
    fertilizerLevel: playerState.fertilizerLevel,
    lastDailyAt: playerState.lastDailyAt !== null ? new Date(playerState.lastDailyAt) : null,
    autoReplant: playerState.autoReplant,
    weeklySnapshotCoins: playerState.weeklySnapshotCoins,
    totalHarvested: playerState.totalHarvested,
    quests: playerState.quests,
    questsResetAt: new Date(playerState.questsResetAt),
    plotSkin: playerState.plotSkin,
    unlockedSkins: playerState.unlockedSkins,
    weatherForecast: playerState.weatherForecast,
    updatedAt: new Date(),
  });

  if (playerState.plots.length > 0) {
    await deps.upsertPlots(
      tx,
      playerState.plots.map((plot, index) => ({
        playerId: playerState.userId,
        plotIndex: index,
        cropId: plot.cropId,
        plantedAt: plot.plantedAt !== null ? new Date(plot.plantedAt) : null,
        notifiedReady: plot.notifiedReady,
      })),
    );
  }

  const inventoryRows = Object.entries(playerState.inventory)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([itemId, quantity]) => ({
      playerId: playerState.userId,
      itemId,
      quantity,
    }));
  if (inventoryRows.length > 0) {
    await deps.upsertInventoryItems(tx, inventoryRows);
  }
}

type TransactionRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

async function getRealTransactionRunner(): Promise<TransactionRunner> {
  // Import dynamique, uniquement au moment de l'appel -- meme raison que
  // getRealDeps() ci-dessus : eviter de declencher la verification
  // DATABASE_URL de @workspace/db au chargement de ce module.
  const { db } = await import("@workspace/db");
  return (fn) => db.transaction(fn);
}

/**
 * Point d'entree autonome : ouvre UNE transaction et delegue a
 * savePlayerWithTx. Commit/rollback entierement geres par Drizzle (throw =
 * rollback automatique).
 */
export async function savePlayer(
  playerState: PlayerState,
  deps: PlayerWriteDeps = realPlayerWriteDeps,
  runTransaction?: TransactionRunner,
): Promise<void> {
  const run = runTransaction ?? (await getRealTransactionRunner());
  await run(async (tx) => {
    await savePlayerWithTx(tx, playerState, deps);
  });
}
