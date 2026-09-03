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
import { asc, eq, sql } from "drizzle-orm";
import { toGlobalState } from "./globalStateAdapter.ts";
import { toPlayerState } from "./playerAdapter.ts";
import type { GlobalState, PlayerState } from "../types";
import type { GlobalStateRecord, PlayerRecord } from "@workspace/db/repositories";
import type {
  db as DbInstance,
  InventoryItem as InventoryItemRow,
  NewInventoryItem,
  NewPlayer,
  NewPlot,
  Player,
  Plot as PlotRow,
} from "@workspace/db";

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
// concurrent ecrase son resultat. La garantie complete anti-lost-update est
// fournie par `mutatePlayer()` (plus bas dans ce fichier) : BEGIN -> SELECT
// ... FOR UPDATE -> reconstruction PlayerState -> mutation metier ->
// ecriture -> COMMIT, le tout dans UNE SEULE transaction ouverte de bout en
// bout, avec un SEUL SELECT ... FOR UPDATE (mutatePlayer n'appelle jamais
// savePlayerWithTx -- il ecrit directement via writePlayerStateAssumingLock
// pour ne pas re-verrouiller une ligne qu'il detient deja). savePlayerWithTx/
// savePlayer restent la voie a utiliser pour une ecriture autonome (pas de
// lecture-mutation-ecriture atomique necessaire) ; ils ne doivent pas etre
// branches sur des commandes concurrentes qui font lire-modifier-ecrire hors
// transaction.
//
// Type du parametre `tx` : derive mecaniquement du type reel de
// `db.transaction` (via `import type { db }`, efface a la compilation --
// aucun import runtime de @workspace/db ici) plutot que reconstruit a la
// main, pour rester exact meme si la version de drizzle-orm change.
type Tx = Parameters<typeof DbInstance.transaction>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;

// Separee de PlayerWriteDeps (qui ajoute lockAndGetPlayer) pour que
// writePlayerStateAssumingLock -- le coeur d'ecriture partage par
// savePlayerWithTx ET mutatePlayer -- ne recoive jamais de quoi reverrouiller
// le joueur : cette dependance-la n'existe tout simplement pas dans son
// parametre `deps`.
export interface PlayerWriteCoreDeps {
  updatePlayerRow: (tx: Tx, playerId: string, values: Omit<NewPlayer, "id" | "createdAt">) => Promise<void>;
  upsertPlots: (tx: Tx, rows: NewPlot[]) => Promise<void>;
  upsertInventoryItems: (tx: Tx, rows: NewInventoryItem[]) => Promise<void>;
}

export interface PlayerWriteDeps extends PlayerWriteCoreDeps {
  lockAndGetPlayer: (tx: Tx, playerId: string) => Promise<Player | null>;
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

// SELECT sans FOR UPDATE : plots/inventory_items n'ont pas de verrou propre
// -- elles sont protegees TRANSITIVEMENT par le verrou deja detenu sur la
// ligne players correspondante (voir le commentaire au-dessus de `type Tx`).
// Ordre par plot_index PRESERVE : toPlayerState() reconstruit Plot[] par
// position de tableau, pas par un champ explicite (meme requete que
// lib/db/src/repositories/playerRepository.ts, mais sur `tx` plutot que
// `db` pour rester dans la transaction courante).
async function realGetPlotsForUpdate(tx: Tx, playerId: string): Promise<PlotRow[]> {
  const { plots } = await getSchemaTables();
  return tx.select().from(plots).where(eq(plots.playerId, playerId)).orderBy(asc(plots.plotIndex));
}

async function realGetInventoryItemsForUpdate(tx: Tx, playerId: string): Promise<InventoryItemRow[]> {
  const { inventoryItems } = await getSchemaTables();
  return tx.select().from(inventoryItems).where(eq(inventoryItems.playerId, playerId));
}

const realPlayerWriteDeps: PlayerWriteDeps = {
  lockAndGetPlayer: realLockAndGetPlayer,
  updatePlayerRow: realUpdatePlayerRow,
  upsertPlots: realUpsertPlots,
  upsertInventoryItems: realUpsertInventoryItems,
};

/**
 * Coeur d'ecriture PARTAGE par savePlayerWithTx et mutatePlayer : ecrit
 * players/plots/inventory_items pour un joueur EN SUPPOSANT QUE LE VERROU
 * (SELECT ... FOR UPDATE) EST DEJA DETENU par l'appelant, dans la MEME
 * transaction -- ne verrouille pas, ne verifie pas l'existence du joueur, ne
 * fait donc AUCUN second SELECT ... FOR UPDATE.
 *
 * `updatedAt` est un parametre explicite (calcule UNE SEULE FOIS par
 * l'appelant, avant cet appel) plutot qu'un `new Date()` genere ici -- pour
 * que l'appelant (notamment mutatePlayer) puisse reporter EXACTEMENT la
 * meme valeur dans le PlayerState qu'il retourne, sans avoir a relire la DB
 * seulement pour ce champ. `created_at` n'est jamais touche par cette
 * fonction (absent de son UPDATE) : `createdAt` ne peut donc jamais changer
 * ici, ni via savePlayerWithTx ni via mutatePlayer.
 *
 * Ne JAMAIS exposer/appeler en dehors d'un verrou deja acquis dans la
 * transaction courante : ce serait rouvrir la fenetre de lost update que
 * savePlayerWithTx/mutatePlayer existent justement pour fermer.
 *
 * - UPDATE cible de players (jamais de suppression/recreation du joueur).
 * - Upsert par lot des plots, cle (player_id, plot_index) -- jamais de DELETE.
 * - Upsert par lot de inventory_items, cle (player_id, item_id) -- une
 *   quantite de 0 reste une ligne valide (n'est jamais retiree).
 */
async function writePlayerStateAssumingLock(
  tx: Tx,
  playerState: PlayerState,
  updatedAt: Date,
  deps: PlayerWriteCoreDeps,
): Promise<void> {
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
    updatedAt,
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

/**
 * Sauvegarde l'etat complet d'un joueur EXISTANT, de facon AUTONOME :
 * verrouille elle-meme le joueur (SELECT ... FOR UPDATE) puis delegue
 * l'ecriture a writePlayerStateAssumingLock. Suppose une transaction deja
 * ouverte (tx) -- ne l'ouvre pas, ne la commit pas, ne la rollback pas
 * elle-meme (delegue entierement a Drizzle : toute exception ici remonte a
 * l'appelant, qui doit etre dans un db.transaction()).
 *
 * Reservee aux appelants qui n'ont PAS deja verrouille le joueur dans la
 * transaction courante (ex. savePlayer, appel autonome). mutatePlayer
 * verrouille deja le joueur pour ses propres besoins (lire plots/inventory
 * de facon coherente avec la mutation) et appelle directement
 * writePlayerStateAssumingLock plutot que cette fonction, pour eviter un
 * second SELECT ... FOR UPDATE redondant sur la meme ligne.
 *
 * - Verrouille et verifie l'existence du joueur (SELECT ... FOR UPDATE).
 *   Absent -> erreur, AUCUNE ecriture n'est tentee ensuite.
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

  await writePlayerStateAssumingLock(tx, playerState, new Date(), deps);
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

// ===========================================================================
// MUTATION ATOMIQUE : mutatePlayer
// ===========================================================================
//
// Ferme la fenetre de lost update que savePlayer(playerState) seul laisse
// ouverte (voir commentaire au-dessus de `type Tx`) : lit le joueur, ses
// plots et son inventaire APRES avoir pose le verrou (SELECT ... FOR
// UPDATE), applique une mutation metier EN MEMOIRE, puis ecrit -- le tout
// dans UNE SEULE transaction, sans jamais relacher le verrou entre la
// lecture et l'ecriture.
//
// UN SEUL SELECT ... FOR UPDATE par appel : mutatePlayer verrouille le
// joueur lui-meme (deps.lockAndGetPlayer) puis appelle directement
// writePlayerStateAssumingLock -- jamais savePlayerWithTx, qui
// re-verrouillerait inutilement la meme ligne deja detenue.
//
// INVARIANTE DE VERROUILLAGE (a ne jamais casser) : plots et
// inventory_items n'ont pas de verrou propre. Ils ne sont proteges contre
// les lost updates que PARCE QUE toute ecriture sur ces tables passe
// exclusivement par writePlayerStateAssumingLock, elle-meme appelee
// uniquement apres un verrou pose sur la ligne players correspondante (par
// savePlayerWithTx ou mutatePlayer). Un futur code qui ecrirait
// plots/inventory_items sans passer par ce chemin (ex. un `tx.update(plots)`
// direct ailleurs dans le code) casserait cette garantie silencieusement.
//
// LE MUTATOR DOIT RESTER UNE OPERATION METIER EN MEMOIRE : il s'execute
// pendant que le verrou PostgreSQL est detenu. Un mutator qui ferait de
// l'I/O reseau/externe (appel HTTP, autre requete DB hors tx, etc.)
// garderait ce verrou pose pendant toute la duree de cette I/O, bloquant
// toute autre commande concurrente visant le meme joueur et immobilisant
// une connexion du pool plus longtemps que necessaire.
export interface MutatePlayerDeps extends PlayerWriteDeps {
  getPlotsForUpdate: (tx: Tx, playerId: string) => Promise<PlotRow[]>;
  getInventoryItemsForUpdate: (tx: Tx, playerId: string) => Promise<InventoryItemRow[]>;
  toPlayerState: (record: PlayerRecord) => PlayerState;
}

const realMutatePlayerDeps: MutatePlayerDeps = {
  ...realPlayerWriteDeps,
  getPlotsForUpdate: realGetPlotsForUpdate,
  getInventoryItemsForUpdate: realGetInventoryItemsForUpdate,
  toPlayerState,
};

/**
 * Lit, mute et sauvegarde l'etat d'un joueur dans UNE SEULE transaction,
 * verrou pose du debut a la fin -- ferme la fenetre de lost update que
 * savePlayer(playerState) seul ne couvre pas (voir commentaire au-dessus de
 * `type Tx`).
 *
 * Deroulement : SELECT ... FOR UPDATE sur players -> (absent -> throw, rien
 * d'autre n'est lu/ecrit) -> SELECT plots (meme tx) -> SELECT
 * inventory_items (meme tx) -> toPlayerState(...) -> mutator(player) EN
 * MEMOIRE -> writePlayerStateAssumingLock (AUCUN second verrou) -> COMMIT.
 * Le PlayerState retourne porte le meme `updatedAt` que celui reellement
 * ecrit en DB (calcule une seule fois, transmis a l'ecriture puis reporte
 * dans l'objet retourne -- pas de relecture DB).
 *
 * `mutator` mute `player` EN PLACE (retour `void`/`Promise<void>`) : cet
 * objet est fraichement construit a l'interieur de cette transaction, sans
 * aucune autre reference externe -- aucun besoin de le cloner avant de le
 * transmettre. `createdAt` n'est jamais modifie ici (writePlayerStateAssumingLock
 * n'ecrit jamais cette colonne).
 *
 * Si `mutator` leve (sync ou async) ou si l'ecriture echoue, l'erreur
 * remonte telle quelle et la transaction entiere est annulee par Drizzle
 * (rollback automatique) -- aucune ecriture partielle possible.
 *
 * Concurrence : deux mutatePlayer ciblant le MEME joueur sont serialises
 * par le SELECT ... FOR UPDATE (le second bloque jusqu'a ce que le premier
 * commit/rollback, puis relit l'etat deja mis a jour -- deux `coins += 1`
 * partant de 50 donnent bien 52, jamais 51). Deux mutatePlayer ciblant des
 * joueurs DIFFERENTS ne se bloquent jamais entre eux (verrous sur des
 * lignes distinctes).
 */
export async function mutatePlayer(
  playerId: string,
  mutator: (player: PlayerState) => void | Promise<void>,
  deps: MutatePlayerDeps = realMutatePlayerDeps,
  runTransaction?: TransactionRunner,
): Promise<PlayerState> {
  const run = runTransaction ?? (await getRealTransactionRunner());

  return run(async (tx) => {
    const playerRow = await deps.lockAndGetPlayer(tx, playerId);
    if (!playerRow) {
      throw new Error(
        `mutatePlayer : joueur "${playerId}" introuvable -- aucune creation automatique, aucune mutation effectuee.`,
      );
    }

    const plotRows = await deps.getPlotsForUpdate(tx, playerId);
    const inventoryRows = await deps.getInventoryItemsForUpdate(tx, playerId);
    const player = deps.toPlayerState({ player: playerRow, plots: plotRows, inventoryItems: inventoryRows });

    await mutator(player);

    const updatedAt = new Date();
    await writePlayerStateAssumingLock(tx, player, updatedAt, deps);
    player.updatedAt = updatedAt.getTime();

    return player;
  });
}
