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
import { asc, desc, eq, sql } from "drizzle-orm";
import { toGlobalState } from "./globalStateAdapter.ts";
import { toPlayerState } from "./playerAdapter.ts";
import type { GlobalState, PlayerState } from "../types";
import type { GlobalStateRecord, PlayerRecord } from "@workspace/db/repositories";
import type {
  ContractRow,
  DailyChallengeContributor,
  DailyChallengeRow,
  db as DbInstance,
  GlobalStateRow,
  InventoryItem as InventoryItemRow,
  NewContractRow,
  NewDailyChallengeContributor,
  NewDailyChallengeRow,
  NewGlobalStateRow,
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
// ORDRE CANONIQUE DES VERROUS (a respecter PARTOUT dans ce fichier, present
// et futur -- seule protection contre un deadlock des qu'une transaction
// doit un jour verrouiller plusieurs ressources a la fois) :
//   1. global_state (singleton id=1)
//   2. contract     (singleton id=1)
//   3. daily_challenge (challenge courant, verrouille de facon deterministe)
//   4. players      (verrouille par mutatePlayer/savePlayerWithTx)
// mutateGlobalState() verrouille 1->2->3, jamais 4. mutatePlayerAndGlobal()
// (categorie E de l'audit de migration, plus bas dans ce fichier) verrouille
// 1->2->3 PUIS 4, dans cet ordre exact et jamais l'inverse -- un chemin qui
// verrouillerait players avant global_state creerait un risque de deadlock
// avec un chemin qui fait l'inverse.
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
  globalState: typeof import("@workspace/db/schema").globalState;
  contract: typeof import("@workspace/db/schema").contract;
  dailyChallenge: typeof import("@workspace/db/schema").dailyChallenge;
  dailyChallengeContributors: typeof import("@workspace/db/schema").dailyChallengeContributors;
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

// ===========================================================================
// MUTATION ATOMIQUE : mutateGlobalState
// ===========================================================================
//
// Meme principe que mutatePlayer(), applique a l'etat GLOBAL (global_state +
// contract + daily_challenge courant) plutot qu'a un joueur : verrouille
// TOUTES les ressources concernees AVANT de les lire, applique une mutation
// metier EN MEMOIRE (destinee a etre `enrichGlobalState(global, now)` de
// ../farm.ts, reutilisee telle quelle), puis ecrit -- le tout dans UNE
// SEULE transaction, verrou tenu du debut a la fin. Ferme la meme fenetre
// de lost update que mutatePlayer() ferme pour un joueur, mais pour les
// transitions globales (meteo, marche, renouvellement du contrat,
// renouvellement du defi quotidien).
//
// ORDRE DES VERROUS : global_state (id=1) -> contract (id=1) -> daily_challenge
// (challenge courant, verrouille par la MEME requete deterministe que
// lib/db/src/repositories/globalStateRepository.ts : ORDER BY started_at
// DESC, id DESC LIMIT 1 FOR UPDATE) -- voir le commentaire canonique
// au-dessus de `type Tx`. Chaque verrou est pose INCONDITIONNELLEMENT
// (meme discipline que mutatePlayer avec le joueur) : on ne sait pas a
// l'avance quelles ressources le mutator va effectivement modifier, donc
// tout ce qui pourrait etre lu-puis-ecrit est verrouille d'emblee.
//
// Puisque global_state est un singleton (id=1) verrouille EN PREMIER par
// TOUTE transaction qui touche l'etat global, son verrou suffit a lui seul
// a serialiser des appels concurrents -- y compris la decision de
// renouveler ou non le defi quotidien (voir plus bas) : un second appel ne
// peut commencer sa propre lecture qu'apres que le premier ait commit/
// rollback, et relit donc systematiquement l'etat DEJA A JOUR. Verrouiller
// aussi contract/daily_challenge individuellement est neanmoins fait par
// prudence (meme discipline "tout ce qui est lu-puis-ecrit est verrouille"
// que pour players/plots/inventory_items) : ca protege aussi contre un
// futur code qui verrouillerait directement contract/daily_challenge sans
// passer par global_state en premier.
//
// LE MUTATOR DOIT RESTER UNE OPERATION METIER EN MEMOIRE : memes
// contraintes que pour mutatePlayer -- rapide, sans appel reseau, sans I/O
// externe, sans autre requete DB hors de cette transaction. Un mutator qui
// ferait de l'I/O externe garderait ces TROIS verrous poses pendant toute
// cette duree, bloquant TOUTE commande qui touche l'etat global (donc,
// potentiellement, une bonne partie du jeu) le temps de cette I/O.
export interface GlobalStateWriteCoreDeps {
  updateGlobalStateRow: (tx: Tx, values: Omit<NewGlobalStateRow, "id">) => Promise<void>;
  updateContractRow: (tx: Tx, values: Omit<NewContractRow, "id">) => Promise<void>;
  updateDailyChallengeRow: (
    tx: Tx,
    challengeId: number,
    values: Omit<NewDailyChallengeRow, "id">,
  ) => Promise<void>;
  insertDailyChallengeRow: (tx: Tx, values: Omit<NewDailyChallengeRow, "id">) => Promise<void>;
}

export interface MutateGlobalStateDeps extends GlobalStateWriteCoreDeps {
  lockAndGetGlobalState: (tx: Tx) => Promise<GlobalStateRow | null>;
  lockAndGetContract: (tx: Tx) => Promise<ContractRow | null>;
  lockAndGetCurrentDailyChallenge: (tx: Tx) => Promise<DailyChallengeRow | null>;
  getDailyChallengeContributors: (tx: Tx, challengeId: number) => Promise<DailyChallengeContributor[]>;
  toGlobalState: (record: GlobalStateRecord) => GlobalState;
}

async function realLockAndGetGlobalState(tx: Tx): Promise<GlobalStateRow | null> {
  const { globalState } = await getSchemaTables();
  const [row] = await tx.select().from(globalState).where(eq(globalState.id, 1)).for("update");
  return row ?? null;
}

async function realLockAndGetContract(tx: Tx): Promise<ContractRow | null> {
  const { contract } = await getSchemaTables();
  const [row] = await tx.select().from(contract).where(eq(contract.id, 1)).for("update");
  return row ?? null;
}

// Meme requete que globalStateRepository.getGlobalStateRecord() (ORDER BY
// started_at DESC, id DESC -- started_at seul n'est pas garanti unique),
// mais avec FOR UPDATE et sur `tx` : verrouille exactement la ligne
// renvoyee, de facon deterministe.
async function realLockAndGetCurrentDailyChallenge(tx: Tx): Promise<DailyChallengeRow | null> {
  const { dailyChallenge } = await getSchemaTables();
  const [row] = await tx
    .select()
    .from(dailyChallenge)
    .orderBy(desc(dailyChallenge.startedAt), desc(dailyChallenge.id))
    .limit(1)
    .for("update");
  return row ?? null;
}

async function realGetDailyChallengeContributors(
  tx: Tx,
  challengeId: number,
): Promise<DailyChallengeContributor[]> {
  const { dailyChallengeContributors } = await getSchemaTables();
  return tx
    .select()
    .from(dailyChallengeContributors)
    .where(eq(dailyChallengeContributors.challengeId, challengeId));
}

async function realUpdateGlobalStateRow(tx: Tx, values: Omit<NewGlobalStateRow, "id">): Promise<void> {
  const { globalState } = await getSchemaTables();
  await tx.update(globalState).set(values).where(eq(globalState.id, 1));
}

async function realUpdateContractRow(tx: Tx, values: Omit<NewContractRow, "id">): Promise<void> {
  const { contract } = await getSchemaTables();
  await tx.update(contract).set(values).where(eq(contract.id, 1));
}

async function realUpdateDailyChallengeRow(
  tx: Tx,
  challengeId: number,
  values: Omit<NewDailyChallengeRow, "id">,
): Promise<void> {
  const { dailyChallenge } = await getSchemaTables();
  await tx.update(dailyChallenge).set(values).where(eq(dailyChallenge.id, challengeId));
}

// INSERT uniquement -- daily_challenge est un historique append-only (voir
// lib/db/src/schema/dailyChallenge.ts) : jamais d'UPDATE d'une ancienne
// ligne pour la "transformer" en nouveau defi, jamais de DELETE d'une
// ancienne ligne. Le nouveau defi devient "courant" simplement parce que
// son started_at est le plus recent (voir realLockAndGetCurrentDailyChallenge).
async function realInsertDailyChallengeRow(tx: Tx, values: Omit<NewDailyChallengeRow, "id">): Promise<void> {
  const { dailyChallenge } = await getSchemaTables();
  await tx.insert(dailyChallenge).values(values);
}

// Upsert (INSERT ... ON CONFLICT DO NOTHING) sur la cle composite
// (challenge_id, player_id) -- pas de mise a jour possible pour une ligne
// deja presente (contributed_at n'a de sens qu'a la PREMIERE contribution),
// pas de DELETE. Reinserer un contributeur deja present est un no-op sans
// erreur : appeler cette fonction avec la liste COMPLETE des contributeurs
// courants (pas seulement les nouveaux) est donc sans danger, c'est le
// choix fait par writeGlobalStateAndContributorsAssumingLock plus bas.
// Specifique a mutatePlayerAndGlobal -- mutateGlobalState() n'ecrit jamais
// cette table (voir son commentaire, LOT 3 : l'ajout de contributeurs est
// une consequence de harvest(), categorie E, pas du renouvellement/des
// transitions temporelles couvertes par mutateGlobalState()).
async function realUpsertDailyChallengeContributors(
  tx: Tx,
  rows: NewDailyChallengeContributor[],
): Promise<void> {
  if (rows.length === 0) return;
  const { dailyChallengeContributors } = await getSchemaTables();
  await tx
    .insert(dailyChallengeContributors)
    .values(rows)
    .onConflictDoNothing({
      target: [dailyChallengeContributors.challengeId, dailyChallengeContributors.playerId],
    });
}

const realMutateGlobalStateDeps: MutateGlobalStateDeps = {
  lockAndGetGlobalState: realLockAndGetGlobalState,
  lockAndGetContract: realLockAndGetContract,
  lockAndGetCurrentDailyChallenge: realLockAndGetCurrentDailyChallenge,
  getDailyChallengeContributors: realGetDailyChallengeContributors,
  updateGlobalStateRow: realUpdateGlobalStateRow,
  updateContractRow: realUpdateContractRow,
  updateDailyChallengeRow: realUpdateDailyChallengeRow,
  insertDailyChallengeRow: realInsertDailyChallengeRow,
  toGlobalState,
};

/**
 * Ecrit global_state/contract/daily_challenge EN SUPPOSANT QUE LES TROIS
 * VERROUS SONT DEJA DETENUS par l'appelant (mutateGlobalState) -- ne
 * verrouille rien, ne relit rien.
 *
 * `originalDailyChallengeId`/`originalDailyChallengeStartedAt` proviennent
 * de la ligne daily_challenge LUE ET VERROUILLEE avant le mutator (le type
 * metier DailyChallengeState n'a pas d'id, donc cette info doit transiter
 * separement -- meme raison que writePlayerStateAssumingLock qui a besoin
 * du player.userId, deja present sur PlayerState, alors qu'ici l'id de
 * ligne daily_challenge n'a pas d'equivalent metier).
 *
 * Decision UPDATE vs INSERT pour daily_challenge : si
 * `global.dailyChallenge.startedAt` differe de la valeur lue au debut de
 * la transaction, le mutator a remplace le defi (renouvellement, voir
 * enrichGlobalState -- `global.dailyChallenge = randomDailyChallenge(now)`)
 * -> INSERT d'une nouvelle ligne, l'ancienne n'est ni modifiee ni
 * supprimee. Sinon, c'est le MEME defi dont seules des valeurs ont pu
 * changer (progress/completed/rewarded) -> UPDATE cible de la ligne deja
 * verrouillee. `dailyChallengeContributors` n'est JAMAIS ecrit ici : ni
 * enrichGlobalState() ni aucun mutator attendu dans ce lot n'y touche
 * (l'ajout de contributeurs est une consequence de harvest(), categorie E
 * de l'audit de migration -- mutatePlayerAndGlobal(), pas encore cree).
 */
async function writeGlobalStateAssumingLock(
  tx: Tx,
  global: GlobalState,
  originalDailyChallengeId: number,
  originalDailyChallengeStartedAt: number,
  deps: GlobalStateWriteCoreDeps,
): Promise<void> {
  await deps.updateGlobalStateRow(tx, {
    marketMultiplier: global.marketMultiplier,
    previousMarketMultiplier: global.previousMarketMultiplier,
    marketUpdatedAt: new Date(global.marketUpdatedAt),
    weather: global.weather,
    weatherMultiplier: global.weatherMultiplier,
    weatherChangedAt: global.weatherChangedAt !== null ? new Date(global.weatherChangedAt) : null,
    weatherExpiresAt: global.weatherExpiresAt !== null ? new Date(global.weatherExpiresAt) : null,
    nextWeatherAt: new Date(global.nextWeatherAt),
    nextWeatherType: global.nextWeatherType,
    weeklyStartedAt: new Date(global.weeklyStartedAt),
  });

  await deps.updateContractRow(tx, {
    cropId: global.contract.cropId,
    required: global.contract.required,
    remaining: global.contract.remaining,
    bonusMultiplier: global.contract.bonusMultiplier,
    renewedAt: new Date(global.contract.renewedAt),
  });

  const dailyChallengeValues = {
    cropId: global.dailyChallenge.cropId,
    target: global.dailyChallenge.target,
    progress: global.dailyChallenge.progress,
    rewardCoins: global.dailyChallenge.rewardCoins,
    startedAt: new Date(global.dailyChallenge.startedAt),
    completed: global.dailyChallenge.completed,
    rewarded: global.dailyChallenge.rewarded,
  };

  const isRenewal = global.dailyChallenge.startedAt !== originalDailyChallengeStartedAt;
  if (isRenewal) {
    await deps.insertDailyChallengeRow(tx, dailyChallengeValues);
  } else {
    await deps.updateDailyChallengeRow(tx, originalDailyChallengeId, dailyChallengeValues);
  }
}

/**
 * Lit, mute et sauvegarde l'etat global (global_state + contract +
 * daily_challenge courant) dans UNE SEULE transaction, les trois verrous
 * poses du debut a la fin -- ferme la fenetre de lost update/double
 * transition que des appels concurrents a `enrichGlobalState` hors
 * transaction laisseraient ouverte.
 *
 * Deroulement : SELECT ... FOR UPDATE sur global_state (absent -> throw,
 * rien d'autre n'est lu/ecrit) -> SELECT ... FOR UPDATE sur contract
 * (absent -> throw, etat incoherent) -> SELECT ... FOR UPDATE sur le
 * daily_challenge courant, ORDER BY started_at DESC, id DESC (absent ->
 * throw, etat incoherent) -> SELECT des contributeurs du defi courant ->
 * toGlobalState(...) -> mutator(global) EN MEMOIRE -> ecriture (AUCUN
 * second verrou) -> COMMIT.
 *
 * `mutator` mute `global` EN PLACE (retour `void`/`Promise<void>`, sync ou
 * async supporte comme mutatePlayer) : cet objet est fraichement construit
 * a l'interieur de cette transaction, sans aucune autre reference externe.
 * Destine a recevoir `(global) => enrichGlobalState(global)` de
 * ../farm.ts, reutilisee telle quelle -- aucune regle metier (formules de
 * marche/meteo/contrat/defi) n'est dupliquee ici.
 *
 * global_state n'a PAS de colonne updated_at technique (contrairement a
 * players) : aucune valeur de ce type n'est donc calculee ni reportee ici.
 *
 * Si `mutator` leve (sync ou async) ou si l'ecriture echoue, l'erreur
 * remonte telle quelle et la transaction entiere est annulee par Drizzle
 * (rollback automatique) -- aucune ecriture partielle possible.
 *
 * Concurrence : deux mutateGlobalState concurrents sont serialises par le
 * SELECT ... FOR UPDATE sur global_state (id=1, verrouille en premier) --
 * le second bloque jusqu'a ce que le premier commit/rollback, puis relit
 * l'etat DEJA A JOUR (y compris un daily_challenge deja renouvele par le
 * premier, ce qui evite de creer deux nouvelles lignes pour UNE seule
 * transition : le second, en relisant l'etat frais, constate via
 * enrichGlobalState() que le renouvellement n'est plus du et n'insere
 * rien).
 */
export async function mutateGlobalState(
  mutator: (global: GlobalState) => void | Promise<void>,
  deps: MutateGlobalStateDeps = realMutateGlobalStateDeps,
  runTransaction?: TransactionRunner,
): Promise<GlobalState> {
  const run = runTransaction ?? (await getRealTransactionRunner());

  return run(async (tx) => {
    const globalRow = await deps.lockAndGetGlobalState(tx);
    if (!globalRow) {
      throw new Error(
        "mutateGlobalState : global_state introuvable (id=1) -- base non initialisee, aucune mutation effectuee.",
      );
    }

    const contractRow = await deps.lockAndGetContract(tx);
    if (!contractRow) {
      throw new Error(
        "mutateGlobalState : contract introuvable (id=1) -- etat incoherent, aucune mutation effectuee.",
      );
    }

    const dailyChallengeRow = await deps.lockAndGetCurrentDailyChallenge(tx);
    if (!dailyChallengeRow) {
      throw new Error(
        "mutateGlobalState : aucun daily_challenge trouve -- etat incoherent, aucune mutation effectuee.",
      );
    }

    const contributorRows = await deps.getDailyChallengeContributors(tx, dailyChallengeRow.id);

    const global = deps.toGlobalState({
      globalState: globalRow,
      contract: contractRow,
      dailyChallenge: dailyChallengeRow,
      dailyChallengeContributors: contributorRows,
    });

    await mutator(global);

    await writeGlobalStateAssumingLock(
      tx,
      global,
      dailyChallengeRow.id,
      dailyChallengeRow.startedAt.getTime(),
      deps,
    );

    return global;
  });
}

// ===========================================================================
// MUTATION ATOMIQUE JOUEUR + GLOBAL : mutatePlayerAndGlobal
// ===========================================================================
//
// Categorie E de l'audit de migration : pour les actions qui doivent muter
// LE JOUEUR ET L'ETAT GLOBAL dans UNE SEULE transaction (harvest -> daily_
// challenge, sell -> contract) -- mutatePlayer() seul et mutateGlobalState()
// seul ne suffisent pas ici : les appeler l'un apres l'autre rouvrirait une
// fenetre de lost update ENTRE les deux (un autre appel pourrait modifier
// le joueur ou le global entre les deux transactions separees).
// mutatePlayerAndGlobal() verrouille les DEUX ressources dans UNE seule
// transaction, sans jamais la relacher entre la lecture et l'ecriture.
//
// ORDRE DES VERROUS : global_state -> contract -> daily_challenge -> player
// (voir le commentaire canonique au-dessus de `type Tx`) -- JAMAIS l'inverse.
// C'est l'unique protection contre un deadlock entre deux transactions qui
// verrouillent les memes ressources : tant que TOUT chemin de code respecte
// cet ordre, deux transactions concurrentes qui se disputent plusieurs
// verrous finissent toujours par se serialiser plutot que de s'attendre
// mutuellement en cycle.
//
// Chaque verrou est pose INCONDITIONNELLEMENT, meme discipline que
// mutatePlayer()/mutateGlobalState() : on ne sait pas a l'avance ce que le
// mutator va effectivement modifier.
//
// REUTILISATION (aucune logique d'ecriture dupliquee) : l'ecriture du
// joueur delegue integralement a writePlayerStateAssumingLock (la meme
// fonction que savePlayerWithTx/mutatePlayer utilisent), l'ecriture de
// l'etat global (global_state/contract/daily_challenge) delegue
// integralement a writeGlobalStateAssumingLock (la meme fonction que
// mutateGlobalState utilise) -- seul l'upsert des contributeurs du defi
// (realUpsertDailyChallengeContributors, ci-dessus) est propre a cette
// fonction, puisque mutateGlobalState() ne touche jamais cette table.
//
// LE MUTATOR DOIT RESTER UNE OPERATION METIER EN MEMOIRE : memes
// contraintes que mutatePlayer()/mutateGlobalState() -- rapide, sans appel
// reseau, sans I/O externe, sans autre requete DB hors de cette
// transaction. Ici, un mutator non conforme garderait QUATRE verrous poses
// simultanement (global_state + contract + daily_challenge + le joueur)
// pendant toute la duree de cette I/O -- le pire cas de contention possible
// dans ce fichier.
export interface MutatePlayerAndGlobalDeps extends MutateGlobalStateDeps, PlayerWriteDeps {
  getPlotsForUpdate: (tx: Tx, playerId: string) => Promise<PlotRow[]>;
  getInventoryItemsForUpdate: (tx: Tx, playerId: string) => Promise<InventoryItemRow[]>;
  toPlayerState: (record: PlayerRecord) => PlayerState;
  upsertDailyChallengeContributors: (tx: Tx, rows: NewDailyChallengeContributor[]) => Promise<void>;
}

const realMutatePlayerAndGlobalDeps: MutatePlayerAndGlobalDeps = {
  ...realMutateGlobalStateDeps,
  ...realPlayerWriteDeps,
  getPlotsForUpdate: realGetPlotsForUpdate,
  getInventoryItemsForUpdate: realGetInventoryItemsForUpdate,
  toPlayerState,
  upsertDailyChallengeContributors: realUpsertDailyChallengeContributors,
};

/**
 * Lit, mute et sauvegarde l'etat d'UN joueur ET l'etat global (global_state
 * + contract + daily_challenge courant) dans UNE SEULE transaction, les
 * QUATRE verrous poses du debut a la fin -- ferme la fenetre de lost update
 * qu'un enchainement mutatePlayer() PUIS mutateGlobalState() (deux
 * transactions separees) laisserait ouverte entre les deux.
 *
 * Deroulement : SELECT ... FOR UPDATE sur global_state (absent -> throw) ->
 * SELECT ... FOR UPDATE sur contract (absent -> throw) -> SELECT ... FOR
 * UPDATE sur le daily_challenge courant, ORDER BY started_at DESC, id DESC
 * (absent -> throw) -> SELECT des contributeurs du defi courant -> SELECT
 * ... FOR UPDATE sur le joueur (absent -> throw) -> SELECT plots (meme tx)
 * -> SELECT inventory_items (meme tx) -> toGlobalState(...) ->
 * toPlayerState(...) -> mutator(player, global) EN MEMOIRE -> ecriture
 * (AUCUN second verrou : writeGlobalStateAssumingLock, upsert des
 * contributeurs si le defi n'a pas ete renouvele, writePlayerStateAssumingLock)
 * -> COMMIT.
 *
 * `mutator` mute `player` ET `global` EN PLACE (retour `void`/`Promise<void>`,
 * sync ou async supporte) : les deux objets sont fraichement construits a
 * l'interieur de cette transaction, sans aucune autre reference externe.
 * Destine a recevoir des fonctions comme harvest(player, global, ...) ou
 * sell(player, global, ...) de ../farm.ts, enveloppees dans une closure
 * (ex. `(player, global) => { result = harvest(player, global); }`, meme
 * pattern que farmPlayerActions.ts) -- aucune regle metier n'est dupliquee
 * ici, harvest()/sell() sont compatibles SANS adaptation (voir le rapport
 * de cette etape).
 *
 * Contributeurs du defi quotidien : apres l'ecriture globale, si le defi
 * n'a PAS ete renouvele (meme comparaison de startedAt que
 * writeGlobalStateAssumingLock utilise en interne pour choisir UPDATE vs
 * INSERT), la liste COURANTE de `global.dailyChallenge.contributors` est
 * upsertee (ON CONFLICT DO NOTHING sur la cle (challenge_id, player_id)) --
 * reinserer un contributeur deja present est un no-op, donc aucun doublon
 * possible et aucun besoin de calculer un diff. Si le defi a ete renouvele,
 * aucun upsert n'est tente (le nouveau defi demarre par construction avec 0
 * contributeur, voir randomDailyChallenge() dans ../constants.ts).
 *
 * `createdAt` (joueur) n'est jamais modifie (writePlayerStateAssumingLock
 * ne l'ecrit jamais). `updatedAt` (joueur) est calcule UNE SEULE FOIS,
 * transmis a l'ecriture puis reporte dans le PlayerState retourne -- meme
 * garantie que mutatePlayer(). global_state n'a pas de colonne updated_at
 * technique (meme remarque que mutateGlobalState()).
 *
 * Si `mutator` leve (sync ou async) ou si l'ecriture echoue, l'erreur
 * remonte telle quelle et la transaction entiere est annulee par Drizzle
 * (rollback automatique) -- aucune ecriture partielle possible.
 */
export async function mutatePlayerAndGlobal(
  playerId: string,
  mutator: (player: PlayerState, global: GlobalState) => void | Promise<void>,
  deps: MutatePlayerAndGlobalDeps = realMutatePlayerAndGlobalDeps,
  runTransaction?: TransactionRunner,
): Promise<{ player: PlayerState; global: GlobalState }> {
  const run = runTransaction ?? (await getRealTransactionRunner());

  return run(async (tx) => {
    const globalRow = await deps.lockAndGetGlobalState(tx);
    if (!globalRow) {
      throw new Error(
        "mutatePlayerAndGlobal : global_state introuvable (id=1) -- base non initialisee, aucune mutation effectuee.",
      );
    }

    const contractRow = await deps.lockAndGetContract(tx);
    if (!contractRow) {
      throw new Error(
        "mutatePlayerAndGlobal : contract introuvable (id=1) -- etat incoherent, aucune mutation effectuee.",
      );
    }

    const dailyChallengeRow = await deps.lockAndGetCurrentDailyChallenge(tx);
    if (!dailyChallengeRow) {
      throw new Error(
        "mutatePlayerAndGlobal : aucun daily_challenge trouve -- etat incoherent, aucune mutation effectuee.",
      );
    }

    const contributorRows = await deps.getDailyChallengeContributors(tx, dailyChallengeRow.id);

    const playerRow = await deps.lockAndGetPlayer(tx, playerId);
    if (!playerRow) {
      throw new Error(
        `mutatePlayerAndGlobal : joueur "${playerId}" introuvable -- aucune creation automatique, aucune mutation effectuee.`,
      );
    }

    const plotRows = await deps.getPlotsForUpdate(tx, playerId);
    const inventoryRows = await deps.getInventoryItemsForUpdate(tx, playerId);

    const global = deps.toGlobalState({
      globalState: globalRow,
      contract: contractRow,
      dailyChallenge: dailyChallengeRow,
      dailyChallengeContributors: contributorRows,
    });
    const player = deps.toPlayerState({ player: playerRow, plots: plotRows, inventoryItems: inventoryRows });

    await mutator(player, global);

    // Ecriture dans le meme ordre que les verrous (global -> player), meme
    // si l'ordre d'ecriture lui-meme n'a pas d'incidence sur le risque de
    // deadlock une fois les quatre verrous deja detenus -- garde le code
    // lisible/previsible.
    const dailyChallengeWasRenewed = global.dailyChallenge.startedAt !== dailyChallengeRow.startedAt.getTime();
    await writeGlobalStateAssumingLock(
      tx,
      global,
      dailyChallengeRow.id,
      dailyChallengeRow.startedAt.getTime(),
      deps,
    );
    if (!dailyChallengeWasRenewed && global.dailyChallenge.contributors.length > 0) {
      await deps.upsertDailyChallengeContributors(
        tx,
        global.dailyChallenge.contributors.map((contributorId) => ({
          challengeId: dailyChallengeRow.id,
          playerId: contributorId,
        })),
      );
    }

    const updatedAt = new Date();
    await writePlayerStateAssumingLock(tx, player, updatedAt, deps);
    player.updatedAt = updatedAt.getTime();

    return { player, global };
  });
}
