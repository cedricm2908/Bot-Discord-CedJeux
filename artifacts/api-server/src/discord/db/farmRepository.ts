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
import { and, asc, desc, eq, isNotNull, like, sql } from "drizzle-orm";
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
  RewardClaim,
} from "@workspace/db";
import {
  freshQuests,
  STARTING_COINS,
  STARTING_PLOTS,
  WEEKLY_INTERVAL_MS,
  WEEKLY_LEADERBOARD_REWARDS,
} from "../constants.ts";

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
  rewardClaims: typeof import("@workspace/db/schema").rewardClaims;
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
// BOOTSTRAP IDEMPOTENT : ensurePlayerExists
// ===========================================================================
//
// LOT 6 (etape "infrastructure uniquement", AUCUNE commande branchee dessus
// pour l'instant). Reproduit EXACTEMENT createPlayer() de ../store.ts (V1,
// jamais modifiee ici) pour un joueur qui n'a pas encore de ligne `players`
// -- necessaire car ni getPlayer() ni mutatePlayer() de ce fichier ne
// creent jamais un joueur automatiquement (contrairement a
// FarmStore.getPlayer(), qui le fait silencieusement a chaque premier
// acces). Les CONSTANTES/FONCTIONS canoniques existantes sont reutilisees
// telles quelles (STARTING_COINS, STARTING_PLOTS, freshQuests() de
// ../constants.ts) -- aucune valeur n'est recopiee a la main.
//
// ATTENTION DEFAUTS SQL INSUFFISANTS : le defaut de colonne de
// `players.unlocked_skins` est `'{}'::text[]` (tableau VIDE), alors que V1
// initialise `unlockedSkins: ["classic"]` -- un simple
// `INSERT ... DEFAULT VALUES` divergerait de V1 des la creation. Chaque
// colonne est donc fixee EXPLICITEMENT ci-dessous (newPlayerRowDefaults),
// sans dependre d'aucun defaut de colonne, meme quand la valeur coincide
// avec V1 (defense en profondeur : un futur changement de defaut SQL ne
// pourra jamais faire diverger silencieusement le bootstrap).
//
// STRATEGIE (INSERT ... ON CONFLICT DO NOTHING, PAS un simple
// SELECT-puis-INSERT) : `players.id` est deja PRIMARY KEY (voir
// lib/db/src/schema/players.ts) -- c'est la cle de conflit naturelle.
// `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING ...` est atomique par
// construction : sous deux transactions concurrentes visant le MEME
// playerId absent, Postgres serialise reellement les deux INSERT sur
// l'index unique (la deuxieme instruction BLOQUE jusqu'a ce que la
// premiere transaction COMMITE ou ROLLBACK, puis reevalue le conflit) --
// UNE SEULE des deux peut donc obtenir `created=true` ; l'autre
// obtient `created=false` et sait, de facon garantie, que la premiere
// transaction est deja entierement commitee (players + plots) au moment ou
// elle relit l'etat pour construire son propre retour. Aucune ligne
// dupliquee, aucun etat partiel observable, sans SELECT prealable ni
// verrou explicite avant l'INSERT.
//
// Les PLOTS de depart (STARTING_PLOTS lignes vides) ne sont inserees QUE
// si CE thread a reellement cree le joueur (created===true) -- jamais pour
// un joueur deja existant (meme si, par hypothese, il avait moins de
// STARTING_PLOTS lignes suite a un etat de seed particulier) : l'exigence
// "ne jamais recreer/dupliquer ses parcelles" est ainsi respectee au sens
// large, pas seulement pour la ligne `players` elle-meme. L'unique
// contrainte (player_id, plot_index) sur `plots` (voir
// lib/db/src/schema/plots.ts) protege quand meme cet INSERT par
// ON CONFLICT DO NOTHING, en defense supplementaire.
//
// L'INVENTAIRE de depart reste INTENTIONNELLEMENT VIDE (aucune ligne
// inventory_items inseree) : V1 initialise `inventory` avec toutes les
// cultures a 0 (Object.fromEntries(CROPS.map(c => [c.id, 0]))), mais
// playerAdapter.ts construit deja `inventory` comme un objet PARTIEL (une
// cle absente se lit `?? 0` partout dans farm.ts, jamais `undefined` traite
// differemment de `0`) -- confirme par le test existant
// "inventory vide quand aucune ligne inventory_items" de
// farmRepository.test.ts. Inserer des lignes a 0 pour chaque culture serait
// un ajout de donnees sans effet observable, jamais fait ailleurs dans ce
// fichier (voir writePlayerStateAssumingLock, qui n'ecrit QUE les entrees
// presentes dans playerState.inventory).
export interface EnsurePlayerExistsDeps extends MutatePlayerDeps {
  tryInsertNewPlayer: (tx: Tx, playerId: string, now: Date) => Promise<boolean>;
  insertStartingPlots: (tx: Tx, playerId: string) => Promise<void>;
}

// Valeurs EXACTES d'un nouveau joueur, reproduisant createPlayer() de
// ../store.ts (V1, jamais modifiee) -- extraites en fonction PURE (aucun
// import de @workspace/db/schema) pour rester directement testable par le
// runner de test natif de Node, contrairement a realTryInsertNewPlayer
// ci-dessous (qui importe dynamiquement le schema -- meme limitation deja
// documentee pour realLockAndGetPlayer/realUpdatePlayerRow/etc., voir le
// commentaire "10." dans farmRepository.test.ts).
export function newPlayerRowDefaults(now: Date): Omit<NewPlayer, "id"> {
  return {
    coins: STARTING_COINS,
    level: 1,
    xp: 0,
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: STARTING_COINS,
    totalHarvested: 0,
    quests: freshQuests(),
    questsResetAt: now,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: null,
    createdAt: now,
    updatedAt: now,
  };
}

// STARTING_PLOTS lignes vides (index 0..STARTING_PLOTS-1), identique a
// Array.from({length: STARTING_PLOTS}, () => ({cropId:null, ...})) de
// createPlayer() (V1) -- meme raison d'extraction pure que ci-dessus.
export function newStartingPlotRows(playerId: string): NewPlot[] {
  return Array.from({ length: STARTING_PLOTS }, (_unused, index) => ({
    playerId,
    plotIndex: index,
    cropId: null,
    plantedAt: null,
    notifiedReady: false,
  }));
}

async function realTryInsertNewPlayer(tx: Tx, playerId: string, now: Date): Promise<boolean> {
  const { players } = await getSchemaTables();
  const inserted = await tx
    .insert(players)
    .values({ id: playerId, ...newPlayerRowDefaults(now) })
    .onConflictDoNothing({ target: players.id })
    .returning({ id: players.id });
  return inserted.length > 0;
}

async function realInsertStartingPlots(tx: Tx, playerId: string): Promise<void> {
  const { plots } = await getSchemaTables();
  await tx
    .insert(plots)
    .values(newStartingPlotRows(playerId))
    .onConflictDoNothing({ target: [plots.playerId, plots.plotIndex] });
}

const realEnsurePlayerExistsDeps: EnsurePlayerExistsDeps = {
  ...realMutatePlayerDeps,
  tryInsertNewPlayer: realTryInsertNewPlayer,
  insertStartingPlots: realInsertStartingPlots,
};

export interface EnsurePlayerExistsResult {
  player: PlayerState;
  created: boolean;
}

/**
 * Garantit qu'une ligne `players` (+ ses STARTING_PLOTS parcelles vides)
 * existe pour `playerId`, en reproduisant EXACTEMENT createPlayer() de
 * ../store.ts (V1) -- SANS jamais toucher un joueur deja existant (aucune
 * remise a zero de coins/inventaire/progression/parcelles, aucune
 * recreation). Atomique : CAS d'insertion + insertion des parcelles dans
 * UNE SEULE transaction (voir commentaire de section ci-dessus pour la
 * preuve de surete en concurrence).
 *
 * Retourne TOUJOURS un `PlayerState` exploitable (joueur nouvellement cree
 * OU deja existant), avec `created` indiquant lequel des deux cas s'est
 * produit -- utile pour un futur appelant qui voudrait, par exemple,
 * logger uniquement les creations reelles (jamais les IDs eux-memes, voir
 * postgresRuntimeAllowlist.ts pour la meme discipline).
 */
export async function ensurePlayerExists(
  playerId: string,
  deps: EnsurePlayerExistsDeps = realEnsurePlayerExistsDeps,
  runTransaction?: TransactionRunner,
  now: Date = new Date(),
): Promise<EnsurePlayerExistsResult> {
  const run = runTransaction ?? (await getRealTransactionRunner());

  return run(async (tx) => {
    const created = await deps.tryInsertNewPlayer(tx, playerId, now);
    if (created) {
      await deps.insertStartingPlots(tx, playerId);
    }

    const playerRow = await deps.lockAndGetPlayer(tx, playerId);
    if (!playerRow) {
      throw new Error(
        `ensurePlayerExists : joueur "${playerId}" introuvable juste apres la tentative de creation -- etat incoherent.`,
      );
    }
    const plotRows = await deps.getPlotsForUpdate(tx, playerId);
    const inventoryRows = await deps.getInventoryItemsForUpdate(tx, playerId);
    const player = deps.toPlayerState({ player: playerRow, plots: plotRows, inventoryItems: inventoryRows });

    return { player, created };
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

// ===========================================================================
// LOT 5 : ELECTION ATOMIQUE + FAN-OUT (weekly, defi quotidien, notifications)
// ===========================================================================
//
// Trois systemes automatiques V1 (bot.ts + farm.ts) doivent pouvoir tourner
// sur PLUSIEURS instances/ticks concurrents sans jamais : distribuer deux
// fois une recompense, faire deux resets weekly, recompenser deux fois un
// defi quotidien, perdre une mutation joueur, ou envoyer deux fois la meme
// notification. Architecture volontairement en DEUX ETAPES SEPAREES,
// jamais une seule grosse transaction verrouillant tous les joueurs :
//
//  1. ELECTION/CLAIM ATOMIQUE : une operation SQL unique (UPDATE ... WHERE
//     ancienne_valeur = ... ou INSERT ... ON CONFLICT DO NOTHING) decide,
//     parmi plusieurs appelants concurrents, UN SEUL gagnant. Les perdants
//     repartent immediatement avec { claimed: false }, sans avoir rien lu
//     ni ecrit d'autre.
//  2. FAN-OUT : le gagnant applique les mutations joueur UNE PAR UNE via
//     mutatePlayer() (weekly, reset de snapshot) ou via
//     claimAndMutatePlayer() (toute recompense reelle -- voir plus bas),
//     jamais via une transaction unique qui verrouillerait tous les
//     joueurs a la fois.
//
// REWARD_CLAIMS -- UTILISATION EXACTE : la table existe deja
// (lib/db/src/schema/rewardClaims.ts, jamais utilisee avant ce lot) avec
// UNIQUE(player_id, claim_type). Son propre commentaire documente deja la
// convention retenue : encoder la PERIODE/le CYCLE dans claim_type (ex.
// "weekly:2026-W36"). Verification faite : claim_type est une colonne TEXT
// libre, sans CHECK ni enum -- rien n'empeche d'y encoder un identifiant de
// cycle STABLE, donc AUCUNE MIGRATION DE SCHEMA n'est necessaire pour ce
// lot (voir le rapport de cette etape, section 13, pour la confirmation
// explicite demandee).
//
// Deux usages DISTINCTS de reward_claims, avec deux familles de
// claim_type :
//  a. "ASSIGNMENT" (weekly uniquement) : qui a gagne quel rang pour quel
//     cycle -- ecrit UNE FOIS par l'election, JAMAIS reecrit. C'est le
//     "plan" persiste durablement SANS nouvelle table : une ligne
//     reward_claims par gagnant suffit, et reste lisible apres un
//     redemarrage complet du processus (voir getWeeklyRewardAssignments).
//  b. "PAYOUT" (weekly + defi quotidien) : le paiement reel (coins += X)
//     est-il DEJA effectue pour ce joueur, pour ce cycle/defi precis --
//     ecrit ATOMIQUEMENT AVEC la mutation du joueur elle-meme, par
//     claimAndMutatePlayer() (voir plus bas), jamais separement.
//
// POURQUOI CETTE SEPARATION EST NECESSAIRE (et pas juste "une ligne
// reward_claims par joueur suffit") : si l'assignation ET le paiement
// partageaient le MEME claim_type, la ligne inseree par l'election
// bloquerait a tort claimAndMutatePlayer() (qui la trouverait deja
// presente et conclurait a tort "deja paye"), alors que le paiement reel
// n'a pas encore eu lieu. Deux claim_type distincts par cycle resolvent
// ce probleme sans ambiguite.
//
// claim_type utilises dans ce lot (toujours texte libre, jamais de
// migration) :
//   "weekly-member:<cycleId>"                         -- population (voir plus bas)
//   "weekly-bonus-assignment:<cycleId>:rank<1|2|3>"  -- assignation (a)
//   "weekly-bonus-payout:<cycleId>"                   -- paiement (b)
//   "weekly-snapshot:<cycleId>"                        -- paiement (b)
//   "daily-challenge-reward:<challengeId>"            -- paiement (b)
// cycleId = epoch ms (en chaine) de l'ancien global_state.weekly_started_at
// AVANT le renouvellement -- stable, unique par cycle, deja disponible
// sans calcul de semaine ISO. challengeId = id reel de la ligne
// daily_challenge (deja stable par construction, table append-only).
//
// "weekly-member:<cycleId>" merite une precision : ce n'est PAS une
// recompense accordee (contrairement aux autres claim_type de ce
// fichier), mais un FAIT durable ("ce joueur appartenait a ce cycle").
// C'est une extension deliberee et assumee de l'usage de reward_claims --
// justifiee par le mecanisme sous-jacent qu'elle fournit deja
// gratuitement (fait idempotent par (player_id, claim_type), horodate,
// jamais duplique) etant EXACTEMENT ce qui est necessaire ici, sans
// ambiguite d'interpretation possible grace au namespace explicite du
// claim_type. Si ce type d'usage devait un jour se multiplier ou devenir
// moins trivial a interpreter, une petite table dediee serait
// preferable -- mais un seul usage, clairement isole et documente, ne le
// justifie pas.
export function weeklyMemberClaimType(cycleId: string): string {
  return `weekly-member:${cycleId}`;
}

export function weeklyBonusAssignmentClaimType(cycleId: string, rank: number): string {
  return `weekly-bonus-assignment:${cycleId}:rank${rank}`;
}

// "weekly-target:<cycleId>:<value>" fige, AU MOMENT DE L'ELECTION, la
// valeur EXACTE que weeklySnapshotCoins devra prendre pour CE joueur dans
// CE cycle -- CORRECTION D'UN BUG REEL : resumeWeeklyRewards() derivait
// auparavant ce snapshot depuis player.coins AU MOMENT DU FAN-OUT (pas de
// l'election), ce qui incluait a tort tout gain/perte de gameplay survenu
// ENTRE l'election et la reprise (potentiellement bien plus tard en cas
// de crash) dans le snapshot de la semaine qui se termine -- au lieu de
// laisser ces gains compter pour la semaine SUIVANTE, comme le fait V1
// (snapshot pris de maniere synchrone AU MOMENT du reset, jamais
// recalcule plus tard).
//
// EVALUATION DE L'ENCODAGE : plutot que de fusionner cette valeur DANS
// "weekly-member:<cycleId>" (ce qui casserait sa recherche par EGALITE
// STRICTE existante -- la valeur, inconnue tant que target n'est pas
// calcule, ne peut pas faire partie d'une cle recherchee par egalite --
// et forcerait tout le code deja teste de
// getWeeklyCycleMembers()/getPendingWeeklyCycleIds() a etre reecrit),
// c'est une famille de claim_type SEPAREE, symetrique a
// "weekly-bonus-assignment:<cycleId>:rank<N>" : le ":" IMMEDIATEMENT
// apres <cycleId> agit comme delimiteur naturel, ce qui rend la recherche
// LIKE-prefixe "weekly-target:<cycleId>:" SURE (aucune collision possible
// avec un cycleId plus long qui commencerait par les memes chiffres,
// exactement le meme raisonnement que pour l'assignation -- contrairement
// a "weekly-member:<cycleId>" qui n'a aucun delimiteur et doit rester en
// EGALITE stricte). <value> est un entier signe (relu via Number(), meme
// niveau de confiance dans les donnees internes que getWeeklyRewardAssignments
// pour <rank>) ; un signe "-" eventuel ne cree aucune ambiguite de parsing
// car <cycleId> ne contient jamais lui-meme de "-" (String(Date.getTime())
// est purement numerique). "text" (PostgreSQL) n'a pas de limite de
// taille pratique pour un entier serialise. Une seule ligne par
// (playerId, cycleId) est garantie par construction : cycleId n'est
// jamais reutilise pour une nouvelle election (le CAS avance
// weekly_started_at de maniere strictement monotone), donc ce claim_type
// n'est jamais insere qu'une seule fois par joueur, DANS LA MEME
// TRANSACTION que l'election -- meme niveau de confiance structurelle que
// "weekly-member"/"weekly-bonus-assignment" deja en production dans ce
// fichier.
export function weeklySnapshotTargetClaimType(cycleId: string, target: number): string {
  return `weekly-target:${cycleId}:${target}`;
}

export function weeklyBonusPayoutClaimType(cycleId: string): string {
  return `weekly-bonus-payout:${cycleId}`;
}

export function dailyChallengeRewardClaimType(challengeId: number): string {
  return `daily-challenge-reward:${challengeId}`;
}

// ---------------------------------------------------------------------------
// claimAndMutatePlayer : primitive de PAIEMENT idempotent, reutilisee par le
// weekly ET le defi quotidien.
// ---------------------------------------------------------------------------
//
// Meme discipline de verrouillage et d'ecriture que mutatePlayer()
// (reutilise directement writePlayerStateAssumingLock -- aucune logique
// d'ecriture dupliquee) : verrouille le joueur (SELECT ... FOR UPDATE),
// PUIS tente d'inserer la ligne reward_claims (INSERT ... ON CONFLICT DO
// NOTHING) DANS LA MEME TRANSACTION que la mutation elle-meme. C'est cette
// atomicite (claim + paiement dans UNE seule transaction, jamais deux
// etapes separees) qui garantit qu'aucun double paiement n'est possible :
// soit les deux reussissent ensemble (COMMIT), soit aucun des deux n'a
// lieu (ROLLBACK, ex. si le mutator leve). Un appel ulterieur avec le
// MEME (playerId, claimType) trouve la ligne deja presente, n'ecrit rien,
// et retourne { claimed: false, player: null } -- sans jamais rejouer la
// mutation.
//
// C'est la maniere correcte de satisfaire "chaque recompense doit passer
// par mutatePlayer()" tout en garantissant l'absence de double paiement :
// mutatePlayer() seul n'a aucune notion de claim et rejouerait la mutation
// a chaque appel.
export interface ClaimAndMutatePlayerDeps extends MutatePlayerDeps {
  tryInsertRewardClaim: (tx: Tx, playerId: string, claimType: string) => Promise<boolean>;
}

async function realTryInsertRewardClaim(tx: Tx, playerId: string, claimType: string): Promise<boolean> {
  const { rewardClaims } = await getSchemaTables();
  const inserted = await tx
    .insert(rewardClaims)
    .values({ playerId, claimType })
    .onConflictDoNothing({ target: [rewardClaims.playerId, rewardClaims.claimType] })
    .returning({ id: rewardClaims.id });
  return inserted.length > 0;
}

const realClaimAndMutatePlayerDeps: ClaimAndMutatePlayerDeps = {
  ...realMutatePlayerDeps,
  tryInsertRewardClaim: realTryInsertRewardClaim,
};

/**
 * Tente de reclamer `claimType` pour `playerId` et, UNIQUEMENT en cas de
 * succes, applique `mutator` et l'ecrit -- le tout dans UNE SEULE
 * transaction (verrou joueur + claim + mutation + ecriture atomiques
 * ensemble). Si la reclamation echoue (ligne reward_claims deja presente
 * pour ce couple), retourne immediatement `{ claimed: false, player: null
 * }` SANS lire plots/inventory, SANS appeler `mutator`, SANS ecrire quoi
 * que ce soit -- idempotent par construction, sans avoir besoin de savoir
 * si un appel precedent a reussi.
 *
 * `mutator` mute `player` EN PLACE, memes contraintes que mutatePlayer()
 * (en memoire, rapide, sans I/O externe -- le verrou joueur est detenu
 * pendant son execution).
 */
export async function claimAndMutatePlayer(
  playerId: string,
  claimType: string,
  mutator: (player: PlayerState) => void | Promise<void>,
  deps: ClaimAndMutatePlayerDeps = realClaimAndMutatePlayerDeps,
  runTransaction?: TransactionRunner,
): Promise<{ claimed: boolean; player: PlayerState | null }> {
  const run = runTransaction ?? (await getRealTransactionRunner());

  return run(async (tx) => {
    const playerRow = await deps.lockAndGetPlayer(tx, playerId);
    if (!playerRow) {
      throw new Error(
        `claimAndMutatePlayer : joueur "${playerId}" introuvable -- aucune creation automatique, aucune mutation effectuee.`,
      );
    }

    const claimed = await deps.tryInsertRewardClaim(tx, playerId, claimType);
    if (!claimed) {
      return { claimed: false, player: null };
    }

    const plotRows = await deps.getPlotsForUpdate(tx, playerId);
    const inventoryRows = await deps.getInventoryItemsForUpdate(tx, playerId);
    const player = deps.toPlayerState({ player: playerRow, plots: plotRows, inventoryItems: inventoryRows });

    await mutator(player);

    const updatedAt = new Date();
    await writePlayerStateAssumingLock(tx, player, updatedAt, deps);
    player.updatedAt = updatedAt.getTime();

    return { claimed: true, player };
  });
}

// ---------------------------------------------------------------------------
// A. WEEKLY RESET / REWARDS
// ---------------------------------------------------------------------------
//
// Regles V1 EXACTES conservees (voir farm.ts:resetWeeklyIfNeeded, jamais
// modifie -- seul le litteral [500,300,150] a ete extrait vers
// WEEKLY_LEADERBOARD_REWARDS dans constants.ts pour eviter toute
// divergence entre V1/JSON et cette primitive, meme valeurs, zero
// changement de comportement) :
//   - du : now - weeklyStartedAt >= WEEKLY_INTERVAL_MS (7 jours).
//   - classement : TOUS les joueurs, tries par (coins - weeklySnapshotCoins)
//     decroissant -- le "gain net" de la semaine.
//   - 3 gagnants exactement (WEEKLY_LEADERBOARD_REWARDS.length), rangs
//     1/2/3 -> +500/+300/+150 coins.
//   - ENSUITE (V1 : boucle separee, apres les bonus), TOUS les joueurs
//     (gagnants inclus) ont leur weeklySnapshotCoins remis a leur coins
//     COURANT -- pour un gagnant, ce coins courant INCLUT deja son bonus
//     (V1 applique les bonus avant la boucle de reset, execution
//     synchrone). Cet ordre est reproduit ici : payer les 3 gagnants
//     D'ABORD, remettre a niveau weeklySnapshotCoins de TOUS les joueurs
//     ENSUITE (voir le commentaire d'orchestration plus bas).
//   - global.weeklyStartedAt = now.
//
// ELECTION : CAS optimiste "UPDATE ... WHERE ancienne_valeur" (PAS de
// SELECT ... FOR UPDATE, pas de lecture-puis-ecriture non atomique) : on
// lit weekly_started_at (sans verrou), on verifie qu'il est du, PUIS on
// tente `UPDATE global_state SET weekly_started_at = now() WHERE id = 1
// AND weekly_started_at = <valeur lue>` -- si un autre appel a gagne
// entre-temps, cette condition ne correspond plus (0 ligne modifiee) et
// cet appel perd proprement, sans avoir rien ecrit. Le classement (lecture
// de TOUS les joueurs, realGetAllPlayersForWeeklyRanking) est UNE SEULE
// requete SQL (`tx.select(...).from(players)`, aucune boucle de lectures
// individuelles), jamais verrouillee -- "PAS de grosse transaction
// verrouillant tous les joueurs". COHERENCE OBTENUE : sous READ COMMITTED
// (isolation par defaut de PostgreSQL, aucune option d'isolation
// specifiee sur db.transaction() ici), chaque INSTRUCTION SQL individuelle
// voit un instantane pris au debut de CETTE instruction -- donc toutes
// les lignes retournees par CETTE UNIQUE requete sont mutuellement
// coherentes, comme observees au meme instant, meme si des joueurs jouent
// simultanement (leurs ecritures concurrentes, si elles commitent apres
// le debut de cette requete, restent simplement invisibles a cette
// lecture -- exactement le comportement souhaite : leurs gains comptent
// pour le cycle SUIVANT). C'est le minimum demande ("au moins une seule
// lecture SQL coherente"), obtenu gratuitement par construction (une
// seule requete), sans SERIALIZABLE ni verrou explicite sur `players`.
//
// ASSIGNATION + POPULATION + CIBLES DE SNAPSHOT DURABLES : des que
// l'election est gagnee, TROIS familles de lignes reward_claims sont
// inserees DANS LA MEME TRANSACTION que le CAS -- c'est le "plan" complet,
// entierement persiste et redecouvrable meme apres un redemarrage complet
// du processus :
//   1. "weekly-member:<cycleId>" -- UNE ligne par joueur de la population
//      (TOUS les joueurs lus pour le classement, gagnants et non-gagnants
//      confondus). C'est la liste FIGEE des joueurs qui appartiennent a
//      CE cycle -- un joueur cree APRES l'election n'aura jamais cette
//      ligne pour ce cycleId, donc ne sera jamais traite pour lui (voir
//      getWeeklyCycleMembers()/resumeWeeklyRewards() plus bas).
//   2. "weekly-bonus-assignment:<cycleId>:rank<N>" -- une ligne par
//      gagnant (deja presente avant cette correction).
//   3. "weekly-target:<cycleId>:<value>" -- une ligne par joueur de la
//      population, encodant la valeur EXACTE (coins observes A
//      L'ELECTION, + bonus pour un gagnant) que weeklySnapshotCoins devra
//      prendre -- CORRECTION D'UN BUG REEL detecte apres coup : sans
//      cette famille, resumeWeeklyRewards() ne pouvait que deriver le
//      snapshot depuis player.coins AU MOMENT DU FAN-OUT, incluant a tort
//      du gameplay survenu entre l'election et la reprise (voir
//      weeklySnapshotTargetClaimType ci-dessus pour le detail complet).
// Redecouvrables via
// getWeeklyCycleMembers()/getWeeklyRewardAssignments()/getWeeklySnapshotTargets().
//
// CORRECTION IMPORTANTE (incoherence d'identite de cycle detectee et
// corrigee) : `cycleId` est TOUJOURS l'ANCIENNE valeur de weekly_started_at
// (celle lue par le peek, AVANT le CAS) -- c'est la semaine qui vient de
// se terminer et qu'on est en train de recompenser. Immediatement apres
// le CAS, global_state.weekly_started_at devient la NOUVELLE valeur (le
// debut de la semaine SUIVANTE, pas encore due) -- getCurrentWeeklyCycleId()
// reflete donc TOUJOURS le cycle EN COURS (ouvert, pas encore elu),
// JAMAIS le cycle qui vient d'etre elu et dont le fan-out doit reprendre.
// Utiliser getCurrentWeeklyCycleId() pour trouver quoi reprendre serait
// une erreur -- c'est precisement pour cela que getPendingWeeklyCycleIds()
// (plus bas) existe : il decouvre TOUS les cycles avec du travail en
// attente directement depuis les lignes reward_claims deja persistees,
// sans jamais dependre de la valeur courante -- forcement unique -- de
// global_state.weekly_started_at.
export interface WeeklyRewardWinner {
  playerId: string;
  rank: number;
  bonus: number;
}

export type WeeklyRewardClaimResult =
  | { claimed: false }
  | { claimed: true; cycleId: string; winners: WeeklyRewardWinner[]; allPlayerIds: string[] };

export interface WeeklyRewardClaimDeps {
  peekWeeklyStartedAt: (tx: Tx) => Promise<Date | null>;
  getAllPlayersForWeeklyRanking: (tx: Tx) => Promise<{ id: string; coins: number; weeklySnapshotCoins: number }[]>;
  tryAdvanceWeeklyStartedAt: (tx: Tx, expectedOldValue: Date, newValue: Date) => Promise<boolean>;
  tryInsertRewardClaim: (tx: Tx, playerId: string, claimType: string) => Promise<boolean>;
}

async function realPeekWeeklyStartedAt(tx: Tx): Promise<Date | null> {
  const { globalState } = await getSchemaTables();
  const [row] = await tx
    .select({ weeklyStartedAt: globalState.weeklyStartedAt })
    .from(globalState)
    .where(eq(globalState.id, 1))
    .limit(1);
  return row ? row.weeklyStartedAt : null;
}

async function realGetAllPlayersForWeeklyRanking(
  tx: Tx,
): Promise<{ id: string; coins: number; weeklySnapshotCoins: number }[]> {
  const { players } = await getSchemaTables();
  return tx
    .select({ id: players.id, coins: players.coins, weeklySnapshotCoins: players.weeklySnapshotCoins })
    .from(players);
}

async function realTryAdvanceWeeklyStartedAt(tx: Tx, expectedOldValue: Date, newValue: Date): Promise<boolean> {
  const { globalState } = await getSchemaTables();
  const updated = await tx
    .update(globalState)
    .set({ weeklyStartedAt: newValue })
    .where(and(eq(globalState.id, 1), eq(globalState.weeklyStartedAt, expectedOldValue)))
    .returning({ id: globalState.id });
  return updated.length > 0;
}

const realWeeklyRewardClaimDeps: WeeklyRewardClaimDeps = {
  peekWeeklyStartedAt: realPeekWeeklyStartedAt,
  getAllPlayersForWeeklyRanking: realGetAllPlayersForWeeklyRanking,
  tryAdvanceWeeklyStartedAt: realTryAdvanceWeeklyStartedAt,
  tryInsertRewardClaim: realTryInsertRewardClaim,
};

/**
 * Election atomique du weekly reset. Retourne `{ claimed: false }` si le
 * cycle n'est pas du OU si un autre appel concurrent a deja gagne (les
 * deux cas sont indiscernables pour l'appelant, et n'ont pas besoin de
 * l'etre : "rien a faire" dans les deux cas). En cas de succes, retourne
 * le plan complet (gagnants + montants + liste de tous les joueurs) --
 * ET, DANS LA MEME TRANSACTION que le CAS, persiste durablement CE PLAN
 * EN ENTIER (population + assignations + cibles de snapshot figees, voir
 * le commentaire de section ci-dessus) : une election commitee a donc
 * TOUJOURS son plan complet
 * disponible en base, meme si le processus crashe immediatement apres
 * (rollback total sinon -- pas d'etat intermediaire possible). Le fan-out
 * lui-meme (paiement des gagnants puis reset de weeklySnapshotCoins) est
 * effectue separement par resumeWeeklyRewards(cycleId), qui n'a besoin
 * d'AUCUN objet en memoire issu de cet appel pour fonctionner.
 *
 * N'effectue AUCUNE mutation joueur elle-meme -- l'appelant doit ensuite
 * appeler resumeWeeklyRewards(cycleId) (voir sa documentation pour l'ordre
 * exact bonus/snapshot, reproduit V1).
 */
export async function tryClaimWeeklyReset(
  deps: WeeklyRewardClaimDeps = realWeeklyRewardClaimDeps,
  runTransaction?: TransactionRunner,
  now: Date = new Date(),
): Promise<WeeklyRewardClaimResult> {
  const run = runTransaction ?? (await getRealTransactionRunner());

  return run(async (tx) => {
    const currentWeeklyStartedAt = await deps.peekWeeklyStartedAt(tx);
    if (!currentWeeklyStartedAt) {
      throw new Error("tryClaimWeeklyReset : global_state introuvable (id=1) -- base non initialisee.");
    }

    if (now.getTime() - currentWeeklyStartedAt.getTime() < WEEKLY_INTERVAL_MS) {
      return { claimed: false };
    }

    const players = await deps.getAllPlayersForWeeklyRanking(tx);
    const ranked = [...players]
      .sort((a, b) => b.coins - b.weeklySnapshotCoins - (a.coins - a.weeklySnapshotCoins))
      .slice(0, WEEKLY_LEADERBOARD_REWARDS.length);
    const winners: WeeklyRewardWinner[] = ranked.map((player, index) => ({
      playerId: player.id,
      rank: index + 1,
      bonus: WEEKLY_LEADERBOARD_REWARDS[index] ?? 0,
    }));

    const advanced = await deps.tryAdvanceWeeklyStartedAt(tx, currentWeeklyStartedAt, now);
    if (!advanced) {
      // Course perdue entre le peek et l'UPDATE : un autre appel a gagne
      // entre-temps. Rien n'a ete ecrit (ni membres, ni assignations).
      return { claimed: false };
    }

    // cycleId = l'ANCIENNE valeur (celle du peek, AVANT le CAS) -- c'est
    // la semaine qui vient de se terminer, voir le commentaire de section
    // ci-dessus pour l'explication complete de ce choix.
    const cycleId = String(currentWeeklyStartedAt.getTime());
    const bonusByPlayerId = new Map(winners.map((winner) => [winner.playerId, winner.bonus]));

    // Population FIGEE du cycle, persistee DANS CETTE MEME TRANSACTION que
    // le CAS -- garantit qu'une election commitee a TOUJOURS sa population
    // complete disponible, jamais partiellement (voir resumeWeeklyRewards
    // et getPendingWeeklyCycleIds plus bas, qui en dependent). Pour CHAQUE
    // membre, la cible EXACTE de weeklySnapshotCoins est calculee ICI,
    // depuis les coins OBSERVES A L'ELECTION (`player.coins` issu de la
    // MEME lecture que le classement, jamais recalcule plus tard) -- regle
    // V1 : bonus puis snapshot, donc pour un gagnant la cible inclut son
    // bonus (coinsAtElection + bonus), et pour un non-gagnant c'est
    // simplement coinsAtElection. Voir weeklySnapshotTargetClaimType
    // ci-dessus pour le detail complet de cette correction.
    for (const player of players) {
      await deps.tryInsertRewardClaim(tx, player.id, weeklyMemberClaimType(cycleId));
      const snapshotTarget = player.coins + (bonusByPlayerId.get(player.id) ?? 0);
      await deps.tryInsertRewardClaim(tx, player.id, weeklySnapshotTargetClaimType(cycleId, snapshotTarget));
    }
    for (const winner of winners) {
      await deps.tryInsertRewardClaim(tx, winner.playerId, weeklyBonusAssignmentClaimType(cycleId, winner.rank));
    }

    return { claimed: true, cycleId, winners, allPlayerIds: players.map((player) => player.id) };
  });
}

/**
 * Redecouvre les gagnants assignes pour un cycle donne, a partir des
 * lignes reward_claims "weekly-bonus-assignment:<cycleId>:rank<N>" --
 * survit a un redemarrage complet du processus (contrairement au plan
 * retourne en memoire par tryClaimWeeklyReset). LECTURE SEULE.
 */
export async function getWeeklyRewardAssignments(
  cycleId: string,
  deps: { listRewardClaimsByPrefix: (prefix: string) => Promise<RewardClaim[]> } = {
    listRewardClaimsByPrefix: realListRewardClaimsByPrefix,
  },
): Promise<WeeklyRewardWinner[]> {
  const prefix = `weekly-bonus-assignment:${cycleId}:rank`;
  const rows = await deps.listRewardClaimsByPrefix(prefix);
  return rows
    .map((row) => {
      const rank = Number(row.claimType.slice(prefix.length));
      return { playerId: row.playerId, rank, bonus: WEEKLY_LEADERBOARD_REWARDS[rank - 1] ?? 0 };
    })
    .sort((a, b) => a.rank - b.rank);
}

async function realListRewardClaimsByPrefix(prefix: string): Promise<RewardClaim[]> {
  const { db } = await import("@workspace/db");
  const { rewardClaims } = await getSchemaTables();
  return db
    .select()
    .from(rewardClaims)
    .where(like(rewardClaims.claimType, `${prefix}%`));
}

export interface WeeklySnapshotTarget {
  playerId: string;
  target: number;
}

/**
 * LECTURE SEULE. Redecouvre, pour un cycle donne, la cible EXACTE de
 * weeklySnapshotCoins fixee A L'ELECTION pour chaque membre (voir
 * weeklySnapshotTargetClaimType plus haut) -- survit a un redemarrage
 * complet, au meme titre que getWeeklyRewardAssignments()/
 * getWeeklyCycleMembers().
 */
export async function getWeeklySnapshotTargets(
  cycleId: string,
  deps: { listRewardClaimsByPrefix: (prefix: string) => Promise<RewardClaim[]> } = {
    listRewardClaimsByPrefix: realListRewardClaimsByPrefix,
  },
): Promise<WeeklySnapshotTarget[]> {
  const prefix = `weekly-target:${cycleId}:`;
  const rows = await deps.listRewardClaimsByPrefix(prefix);
  return rows.map((row) => ({ playerId: row.playerId, target: Number(row.claimType.slice(prefix.length)) }));
}

// claim_type du PAIEMENT (par opposition a l'ASSIGNATION ci-dessus) du
// reset de weeklySnapshotCoins, par joueur et par cycle -- idempotent,
// distinct du paiement du bonus pour ne jamais confondre "ce joueur a
// deja recu son snapshot remis a niveau" avec "ce joueur a deja recu son
// bonus" (ce sont deux operations independantes, voir
// resumeWeeklyRewards() ci-dessous).
export function weeklySnapshotClaimType(cycleId: string): string {
  return `weekly-snapshot:${cycleId}`;
}

/**
 * LECTURE SEULE. Identifiant du cycle hebdomadaire EN COURS (celui associe
 * a la valeur ACTUELLE de global_state.weekly_started_at) -- c'est-a-dire
 * le cycle OUVERT, pas encore du, PAS le dernier cycle elu. Utile pour
 * afficher "ou en est la semaine courante" (ex. un futur /weekly), mais
 * PAS pour decouvrir quels cycles ont un fan-out en attente : des qu'une
 * election reussit, cette valeur change immediatement pour designer le
 * cycle SUIVANT (voir le commentaire au-dessus de tryClaimWeeklyReset) --
 * utiliser getPendingWeeklyCycleIds() pour la reprise.
 */
export async function getCurrentWeeklyCycleId(
  deps: { getGlobalState: typeof getGlobalState } = { getGlobalState },
): Promise<string | null> {
  const global = await deps.getGlobalState();
  return global ? String(global.weeklyStartedAt) : null;
}

export interface GetWeeklyCycleMembersDeps {
  getRewardClaimsByExactType: (claimType: string) => Promise<RewardClaim[]>;
}

// EGALITE STRICTE (pas de LIKE-prefixe) : contrairement a l'assignation
// ("...:rank<N>", ou le ":rank" agit comme delimiteur naturel apres le
// cycleId), "weekly-member:<cycleId>" n'a AUCUN suffixe -- un LIKE-prefixe
// sur un cycleId partiel matcherait a tort un AUTRE cycleId plus long qui
// le commence (ex. rechercher "170" matcherait aussi "1700000000000").
// L'egalite stricte elimine tout risque de collision.
async function realGetRewardClaimsByExactType(claimType: string): Promise<RewardClaim[]> {
  const { db } = await import("@workspace/db");
  const { rewardClaims } = await getSchemaTables();
  return db.select().from(rewardClaims).where(eq(rewardClaims.claimType, claimType));
}

const realGetWeeklyCycleMembersDeps: GetWeeklyCycleMembersDeps = {
  getRewardClaimsByExactType: realGetRewardClaimsByExactType,
};

/**
 * LECTURE SEULE. Retrouve la population FIGEE d'un cycle (les joueurs
 * presents au moment de l'election, persistes durablement par
 * tryClaimWeeklyReset() via "weekly-member:<cycleId>") -- jamais une
 * lecture fraiche de getAllPlayers(), justement pour qu'un joueur cree
 * APRES l'election ne devienne jamais membre d'un cycle passe.
 */
export async function getWeeklyCycleMembers(
  cycleId: string,
  deps: GetWeeklyCycleMembersDeps = realGetWeeklyCycleMembersDeps,
): Promise<string[]> {
  const rows = await deps.getRewardClaimsByExactType(weeklyMemberClaimType(cycleId));
  return rows.map((row) => row.playerId);
}

export interface WeeklyResumeDeps {
  getWeeklyRewardAssignments: (cycleId: string) => Promise<WeeklyRewardWinner[]>;
  getWeeklyCycleMembers: (cycleId: string) => Promise<string[]>;
  getWeeklySnapshotTargets: (cycleId: string) => Promise<WeeklySnapshotTarget[]>;
  claimAndMutatePlayer: typeof claimAndMutatePlayer;
}

const realWeeklyResumeDeps: WeeklyResumeDeps = {
  getWeeklyRewardAssignments,
  getWeeklyCycleMembers,
  getWeeklySnapshotTargets,
  claimAndMutatePlayer,
};

export interface WeeklyResumeResult {
  cycleId: string;
  winners: WeeklyRewardWinner[];
  processedPlayerCount: number;
}

/**
 * Reprend (ou effectue pour la premiere fois) le fan-out complet d'un
 * cycle hebdomadaire DEJA ELU, identifie par `cycleId` (obtenu via
 * getPendingWeeklyCycleIds() apres un redemarrage, ou directement retourne
 * par tryClaimWeeklyReset() au moment de l'election). ENTIEREMENT
 * reconstructible depuis PostgreSQL : les gagnants ET la population sont
 * TOUS deux relus depuis les lignes deja persistees par
 * tryClaimWeeklyReset() (getWeeklyRewardAssignments/getWeeklyCycleMembers)
 * -- AUCUN plan ne doit survivre en memoire entre deux appels, et AUCUN
 * joueur cree apres l'election n'est jamais inclus (contrairement a une
 * version anterieure de cette fonction qui utilisait a tort une lecture
 * fraiche de getAllPlayers()).
 *
 * Pour CHAQUE membre FIGE du cycle, DANS CET ORDRE STRICT (garanti par
 * `await` sequentiel a l'interieur de chaque tache, mais les joueurs
 * entre eux sont traites EN PARALLELE -- pas de grosse transaction) :
 *  1. S'il est gagnant (present dans les assignations) :
 *     claimAndMutatePlayer(playerId, weeklyBonusPayoutClaimType(cycleId),
 *     (p) => { p.coins += bonus; }) -- idempotent, deja paye = no-op.
 *  2. ENSUITE SEULEMENT : claimAndMutatePlayer(playerId,
 *     weeklySnapshotClaimType(cycleId), (p) => { p.weeklySnapshotCoins =
 *     snapshotTarget; }) -- idempotent, deja fait = no-op.
 * Cet ordre (bonus PUIS snapshot, jamais l'inverse, jamais en parallele
 * pour un MEME joueur) reproduit le comportement V1 (boucle synchrone :
 * bonus d'abord, reset de weeklySnapshotCoins ensuite pour tout le
 * monde). IMPORTANT (correction) : `snapshotTarget` est relu depuis
 * getWeeklySnapshotTargets(cycleId) -- la valeur FIGEE A L'ELECTION,
 * JAMAIS `p.coins` au moment du fan-out. Une version anterieure de cette
 * fonction faisait `p.weeklySnapshotCoins = p.coins`, ce qui incluait a
 * tort tout gain/perte de gameplay survenu ENTRE l'election et la reprise
 * (potentiellement bien plus tard en cas de crash) dans le snapshot de la
 * semaine qui se termine, au lieu de les laisser compter pour la semaine
 * SUIVANTE (voir weeklySnapshotTargetClaimType ci-dessus).
 */
export async function resumeWeeklyRewards(
  cycleId: string,
  deps: WeeklyResumeDeps = realWeeklyResumeDeps,
): Promise<WeeklyResumeResult> {
  const winners = await deps.getWeeklyRewardAssignments(cycleId);
  const winnerByPlayerId = new Map(winners.map((winner) => [winner.playerId, winner]));
  const memberIds = await deps.getWeeklyCycleMembers(cycleId);
  const targets = await deps.getWeeklySnapshotTargets(cycleId);
  const targetByPlayerId = new Map(targets.map((target) => [target.playerId, target.target]));

  await Promise.all(
    memberIds.map(async (playerId) => {
      const winner = winnerByPlayerId.get(playerId);
      if (winner) {
        await deps.claimAndMutatePlayer(playerId, weeklyBonusPayoutClaimType(cycleId), (p) => {
          p.coins += winner.bonus;
        });
      }
      const snapshotTarget = targetByPlayerId.get(playerId);
      if (snapshotTarget === undefined) {
        throw new Error(
          `resumeWeeklyRewards : snapshotTarget introuvable pour le joueur "${playerId}" dans le cycle "${cycleId}" -- etat incoherent (weekly-member et weekly-target sont censes etre inseres ensemble, dans la meme transaction, par tryClaimWeeklyReset).`,
        );
      }
      await deps.claimAndMutatePlayer(playerId, weeklySnapshotClaimType(cycleId), (p) => {
        p.weeklySnapshotCoins = snapshotTarget;
      });
    }),
  );

  return { cycleId, winners, processedPlayerCount: memberIds.length };
}

// ---------------------------------------------------------------------------
// DECOUVERTE MULTI-CYCLES : getPendingWeeklyCycleIds
// ---------------------------------------------------------------------------
//
// Repond precisement au probleme souleve : un cycle A elu, partiellement
// distribue, puis un cycle B qui devient du plus tard NE DOIT PAS rendre A
// introuvable. global_state.weekly_started_at, en tant que colonne
// UNIQUE et mutable, ne peut structurellement designer qu'UN SEUL cycle a
// la fois (le courant) -- il est donc STRUCTURELLEMENT incapable de
// repondre a "quels cycles ont du travail en attente" des qu'il existe
// plus d'un cycle concerne. La reponse ne peut venir que d'une source qui
// accumule TOUS les cycles jamais elus : les lignes reward_claims
// elles-memes (jamais purgees, jamais ecrasees).
//
// Un cycle est considere COMPLET (donc absent du resultat) si et
// seulement si :
//   - chaque "weekly-member:<cycleId>" a un "weekly-snapshot:<cycleId>"
//     correspondant pour le MEME playerId ;
//   - ET chaque "weekly-bonus-assignment:<cycleId>:rank<N>" a un
//     "weekly-bonus-payout:<cycleId>" correspondant pour le MEME playerId.
// Ce n'est PAS "tous les joueurs actuels ont un snapshot" (ce qui
// inclurait a tort des joueurs crees apres l'election) -- c'est
// explicitement borne a la population FIGEE du cycle (les membres
// persistes), conformement a la semantique V1 demandee.
export interface WeeklyCyclePendingCheck {
  cycleId: string;
  memberCount: number;
  pendingSnapshotCount: number;
  winners: WeeklyRewardWinner[];
  pendingPayoutCount: number;
  isComplete: boolean;
}

interface ParsedWeeklyClaim {
  kind: "member" | "snapshot" | "assignment" | "payout";
  cycleId: string;
  playerId: string;
  rank?: number;
}

function parseWeeklyClaim(claim: RewardClaim): ParsedWeeklyClaim | null {
  const assignmentPrefix = "weekly-bonus-assignment:";
  const payoutPrefix = "weekly-bonus-payout:";
  const snapshotPrefix = "weekly-snapshot:";
  const memberPrefix = "weekly-member:";

  if (claim.claimType.startsWith(assignmentPrefix)) {
    const rest = claim.claimType.slice(assignmentPrefix.length);
    const match = /^(.+):rank(\d+)$/.exec(rest);
    if (!match) return null;
    return { kind: "assignment", cycleId: match[1]!, playerId: claim.playerId, rank: Number(match[2]) };
  }
  if (claim.claimType.startsWith(payoutPrefix)) {
    return { kind: "payout", cycleId: claim.claimType.slice(payoutPrefix.length), playerId: claim.playerId };
  }
  if (claim.claimType.startsWith(snapshotPrefix)) {
    return { kind: "snapshot", cycleId: claim.claimType.slice(snapshotPrefix.length), playerId: claim.playerId };
  }
  if (claim.claimType.startsWith(memberPrefix)) {
    return { kind: "member", cycleId: claim.claimType.slice(memberPrefix.length), playerId: claim.playerId };
  }
  return null;
}

async function realListWeeklyClaims(): Promise<RewardClaim[]> {
  const { db } = await import("@workspace/db");
  const { rewardClaims } = await getSchemaTables();
  return db.select().from(rewardClaims).where(like(rewardClaims.claimType, "weekly-%"));
}

/**
 * LECTURE SEULE. Retrouve TOUS les cycles hebdomadaires dont le fan-out
 * est incomplet (au moins un membre sans snapshot, ou au moins un gagnant
 * non paye) -- jamais seulement le cycle courant. Un cycle plus ancien,
 * dont le fan-out a ete interrompu, reste TOUJOURS decouvrable ici, meme
 * apres qu'un ou plusieurs cycles suivants aient ete elus (les lignes
 * reward_claims ne sont jamais purgees ni ecrasees -- voir le commentaire
 * de section ci-dessus).
 */
export async function getPendingWeeklyCycleIds(
  deps: { listWeeklyClaims: () => Promise<RewardClaim[]> } = { listWeeklyClaims: realListWeeklyClaims },
): Promise<string[]> {
  const claims = await deps.listWeeklyClaims();
  const cycles = new Map<
    string,
    { members: Set<string>; snapshots: Set<string>; winners: Map<string, number>; payouts: Set<string> }
  >();

  const getCycle = (cycleId: string) => {
    let cycle = cycles.get(cycleId);
    if (!cycle) {
      cycle = { members: new Set(), snapshots: new Set(), winners: new Map(), payouts: new Set() };
      cycles.set(cycleId, cycle);
    }
    return cycle;
  };

  for (const claim of claims) {
    const parsed = parseWeeklyClaim(claim);
    if (!parsed) continue;
    const cycle = getCycle(parsed.cycleId);
    if (parsed.kind === "member") cycle.members.add(parsed.playerId);
    else if (parsed.kind === "snapshot") cycle.snapshots.add(parsed.playerId);
    else if (parsed.kind === "payout") cycle.payouts.add(parsed.playerId);
    else cycle.winners.set(parsed.playerId, parsed.rank ?? 0);
  }

  const pending: string[] = [];
  for (const [cycleId, cycle] of cycles) {
    const allMembersSnapshotted = [...cycle.members].every((playerId) => cycle.snapshots.has(playerId));
    const allWinnersPaid = [...cycle.winners.keys()].every((playerId) => cycle.payouts.has(playerId));
    if (!allMembersSnapshotted || !allWinnersPaid) {
      pending.push(cycleId);
    }
  }
  return pending;
}

// ---------------------------------------------------------------------------
// B. DAILY CHALLENGE REWARD -- PAIEMENT D'ABORD, FINALISATION ENSUITE
// ---------------------------------------------------------------------------
//
// Regles V1 EXACTES conservees (voir farm.ts:distributeDailyChallengeReward,
// jamais modifie) : le defi doit etre `completed && !rewarded` ; CHAQUE
// contributeur recoit exactement `rewardCoins` (montant fixe, pas de
// calcul de rang) ; aucune autre condition de participation.
//
// CORRECTION IMPORTANTE PAR RAPPORT A UNE PREMIERE VERSION DE CE LOT :
// l'architecture initiale faisait `rewarded: false -> true` COMME
// election, AVANT le fan-out des paiements -- dangereux, car un crash
// entre la finalisation et la fin du fan-out aurait laisse
// `rewarded=true` alors que certains contributeurs n'auraient jamais ete
// payes, avec plus aucun signal pour reprendre (un futur redemarrage
// verrait "deja recompense" et ne retenterait plus rien). CORRIGE : le
// paiement par contributeur passe maintenant TOUJOURS en premier
// (idempotent, voir claimAndMutatePlayer), et `rewarded` ne passe a
// `true` qu'EN DERNIER, une fois TOUS les paiements confirmes -- il
// retrouve ainsi sa signification V1 exacte : "la distribution est
// TERMINEE", jamais "une election a eu lieu".
//
// AVANTAGE STRUCTUREL PAR RAPPORT AU WEEKLY : le "plan" (challengeId,
// rewardCoins, liste des contributeurs) est ENTIEREMENT derivable de
// donnees DEJA PERSISTEES et STABLES (daily_challenge + ses
// daily_challenge_contributors, une table append-only qui n'evolue plus
// une fois `completed = true` -- voir farm.ts:harvest, l'ajout de
// contributeurs est conditionne a `!global.dailyChallenge.completed`).
// AUCUNE information ephemere (aucun "plan" en memoire) n'est necessaire
// pour decouvrir OU reprendre ce fan-out apres un redemarrage complet.
//
// DECOUVERTE (reprise apres redemarrage complet, sans etat memoire) :
// getUnrewardedCompletedDailyChallenges() retrouve TOUS les defis
// `completed=true AND rewarded=false` -- pas seulement le defi COURANT
// (contrairement a realLockAndGetCurrentDailyChallenge, ORDER BY
// started_at DESC LIMIT 1, utilise par mutateGlobalState/
// mutatePlayerAndGlobal) : un ANCIEN defi dont la distribution a ete
// interrompue reste ainsi TOUJOURS retrouvable, meme apres la creation
// d'un ou plusieurs defis suivants (table append-only, aucune ligne
// n'est jamais perdue ni ecrasee).
//
// PAIEMENT : pour CHAQUE contributeur, claimAndMutatePlayer(contributorId,
// dailyChallengeRewardClaimType(challengeId), ...) -- idempotent par
// construction : plusieurs schedulers concurrents peuvent tenter le meme
// fan-out sans jamais payer deux fois un contributeur deja traite.
//
// FINALISATION : UNIQUEMENT apres que le fan-out de paiement a termine
// SANS EXCEPTION pour tous les contributeurs (garanti par Promise.all --
// s'il rejette, aucune finalisation n'est tentee), CAS optimiste
// `UPDATE daily_challenge SET rewarded = true WHERE id = <challengeId>
// AND completed = true AND rewarded = false`. Si deux schedulers
// terminent leur fan-out en meme temps, un seul gagne cette derniere
// ecriture -- sans consequence, puisque les paiements individuels sont
// deja tous idempotents.
export interface GetUnrewardedCompletedDailyChallengesDeps {
  listUnrewardedCompletedDailyChallenges: () => Promise<DailyChallengeRow[]>;
}

async function realListUnrewardedCompletedDailyChallenges(): Promise<DailyChallengeRow[]> {
  const { db } = await import("@workspace/db");
  const { dailyChallenge } = await getSchemaTables();
  return db
    .select()
    .from(dailyChallenge)
    .where(and(eq(dailyChallenge.completed, true), eq(dailyChallenge.rewarded, false)))
    .orderBy(asc(dailyChallenge.startedAt));
}

const realGetUnrewardedCompletedDailyChallengesDeps: GetUnrewardedCompletedDailyChallengesDeps = {
  listUnrewardedCompletedDailyChallenges: realListUnrewardedCompletedDailyChallenges,
};

/**
 * LECTURE SEULE. Retrouve TOUS les daily_challenge dont la distribution de
 * recompense est incomplete (completed=true, rewarded=false) -- jamais
 * seulement "le" defi courant. C'est le point d'entree de la reprise
 * apres un redemarrage complet du processus : aucun etat memoire requis,
 * chaque challengeId retourne peut etre passe directement a
 * resumeDailyChallengeReward().
 */
export async function getUnrewardedCompletedDailyChallenges(
  deps: GetUnrewardedCompletedDailyChallengesDeps = realGetUnrewardedCompletedDailyChallengesDeps,
): Promise<DailyChallengeRow[]> {
  return deps.listUnrewardedCompletedDailyChallenges();
}

export interface DailyChallengeResumeDeps {
  getDailyChallengeById: (challengeId: number) => Promise<DailyChallengeRow | null>;
  getDailyChallengeContributors: (challengeId: number) => Promise<DailyChallengeContributor[]>;
  claimAndMutatePlayer: typeof claimAndMutatePlayer;
  tryFinalizeDailyChallengeRewarded: (challengeId: number) => Promise<boolean>;
}

async function realGetDailyChallengeById(challengeId: number): Promise<DailyChallengeRow | null> {
  const { db } = await import("@workspace/db");
  const { dailyChallenge } = await getSchemaTables();
  const [row] = await db.select().from(dailyChallenge).where(eq(dailyChallenge.id, challengeId)).limit(1);
  return row ?? null;
}

async function realGetDailyChallengeContributorsStandalone(
  challengeId: number,
): Promise<DailyChallengeContributor[]> {
  const { db } = await import("@workspace/db");
  const { dailyChallengeContributors } = await getSchemaTables();
  return db
    .select()
    .from(dailyChallengeContributors)
    .where(eq(dailyChallengeContributors.challengeId, challengeId));
}

// Meme requete que realTryMarkDailyChallengeRewarded (nom conserve pour
// designer le CAS lui-meme), mais appelee ICI en tout dernier, comme
// FINALISATION -- jamais comme election prealable (voir le commentaire de
// section ci-dessus). Autonome (utilise `db` directement, pas `tx`) :
// une seule instruction UPDATE, deja atomique par elle-meme, exactement
// comme claimReadyPlotNotification.
async function realTryMarkDailyChallengeRewarded(challengeId: number): Promise<boolean> {
  const { db } = await import("@workspace/db");
  const { dailyChallenge } = await getSchemaTables();
  const updated = await db
    .update(dailyChallenge)
    .set({ rewarded: true })
    .where(
      and(
        eq(dailyChallenge.id, challengeId),
        eq(dailyChallenge.completed, true),
        eq(dailyChallenge.rewarded, false),
      ),
    )
    .returning({ id: dailyChallenge.id });
  return updated.length > 0;
}

const realDailyChallengeResumeDeps: DailyChallengeResumeDeps = {
  getDailyChallengeById: realGetDailyChallengeById,
  getDailyChallengeContributors: realGetDailyChallengeContributorsStandalone,
  claimAndMutatePlayer,
  tryFinalizeDailyChallengeRewarded: realTryMarkDailyChallengeRewarded,
};

export interface DailyChallengeResumeResult {
  challengeId: number;
  rewardCoins: number;
  contributorIds: string[];
  finalized: boolean;
}

/**
 * Reprend (ou effectue pour la premiere fois) la distribution de
 * recompense d'un defi quotidien PRECIS, identifie par son `challengeId`
 * (obtenu via getUnrewardedCompletedDailyChallenges(), ou directement
 * connu de l'appelant). Fonctionne A L'IDENTIQUE que ce soit le tout
 * premier appel pour ce defi ou une reprise apres crash partiel :
 *
 *  1. Lit le defi par id (erreur explicite si absent ou si `!completed`
 *     -- rien a distribuer).
 *  2. Lit ses contributeurs (table stable, jamais modifiee une fois le
 *     defi complete).
 *  3. Pour CHAQUE contributeur, EN PARALLELE : claimAndMutatePlayer(...)
 *     -- idempotent, un contributeur deja paye lors d'un appel precedent
 *     n'est PAS repaye (son claim existe deja, `claimed: false`, aucune
 *     mutation rejouee).
 *  4. UNIQUEMENT si l'etape 3 se termine SANS EXCEPTION pour tous les
 *     contributeurs (Promise.all) : tente la finalisation `rewarded =
 *     true`. Si elle echoue au niveau applicatif (une des promesses
 *     rejette), AUCUNE finalisation n'est tentee -- l'appel suivant
 *     (reprise) retentera les contributeurs manquants avant de refinaliser.
 *
 * Plusieurs appels concurrents sur le MEME challengeId (plusieurs
 * schedulers) sont surs : chaque paiement individuel est idempotent, et
 * la finalisation elle-meme est un CAS (un seul gagne, les autres no-op).
 */
export async function resumeDailyChallengeReward(
  challengeId: number,
  deps: DailyChallengeResumeDeps = realDailyChallengeResumeDeps,
): Promise<DailyChallengeResumeResult> {
  const challenge = await deps.getDailyChallengeById(challengeId);
  if (!challenge) {
    throw new Error(`resumeDailyChallengeReward : daily_challenge id=${challengeId} introuvable.`);
  }
  if (!challenge.completed) {
    throw new Error(
      `resumeDailyChallengeReward : daily_challenge id=${challengeId} n'est pas "completed" -- rien a distribuer.`,
    );
  }

  const contributorRows = await deps.getDailyChallengeContributors(challengeId);
  const contributorIds = contributorRows.map((row) => row.playerId);

  await Promise.all(
    contributorIds.map((contributorId) =>
      deps.claimAndMutatePlayer(contributorId, dailyChallengeRewardClaimType(challengeId), (player) => {
        player.coins += challenge.rewardCoins;
      }),
    ),
  );

  const finalized = challenge.rewarded ? false : await deps.tryFinalizeDailyChallengeRewarded(challengeId);

  return { challengeId, rewardCoins: challenge.rewardCoins, contributorIds, finalized };
}

// ---------------------------------------------------------------------------
// C. NOTIFICATION DE PARCELLE PRETE -- claim atomique, PAS d'envoi Discord
// ---------------------------------------------------------------------------
//
// Comportement V1 exact (bot.ts:notifyReadyCrops) : pour chaque parcelle
// avec `cropId` non nul, `!notifiedReady` et `isReady(...)`, un DM Discord
// est envoye PUIS `plot.notifiedReady = true` est positionne. En V1, ceci
// est sur, car synchrone et mono-process (aucune course possible). En
// Postgres, le risque explicite a eviter est : lire notifiedReady=false,
// envoyer Discord, ecrire true -- deux ticks concurrents liraient tous
// deux `false` et enverraient chacun un message.
//
// Cette primitive ne fait QUE la transition atomique `notified_ready:
// false -> true`, en une SEULE instruction SQL (UPDATE ... WHERE ...
// RETURNING), sans transaction explicite -- Postgres garantit deja
// l'atomicite d'une instruction unique. Elle ne connait ni Discord, ni le
// contenu du message : c'est au futur appelant (runtime, hors de ce lot)
// de faire "claim DB, PUIS envoyer Discord SEULEMENT si claimed=true".
//
// EXCEPTION DOCUMENTEE a l'invariant "plots n'est ecrit que via
// writePlayerStateAssumingLock, apres verrou joueur" (etabli au LOT 2) :
// cette primitive ecrit `plots.notified_ready` DIRECTEMENT, sans passer
// par un verrou de ligne players. C'est sur car il ne s'agit PAS d'un
// pattern lire-muter-ecrire d'un PlayerState complet (ce que l'invariant
// protege) mais d'un CAS auto-contenu en une seule instruction, exactement
// comme les CAS de global_state/daily_challenge ci-dessus.
//
// GARDE SUPPLEMENTAIRE (au-dela du minimum demande) : `expectedPlantedAt`
// est verifie dans le WHERE -- si la parcelle a ete recoltee puis
// replantee entre l'observation "c'est pret" et l'appel a cette primitive,
// `planted_at` a change et le claim echoue proprement (0 ligne modifiee),
// evitant de notifier a tort pour une toute nouvelle plantation.
//
// CLAIM DB REUSSI PUIS CRASH AVANT ENVOI DISCORD -- ANALYSE ET CHOIX
// RECOMMANDE : deux ordres possibles.
//   (1) claim PUIS envoi (retenu) : un crash entre les deux perd
//       DEFINITIVEMENT cette notification precise (notified_ready reste a
//       true, plus jamais retentee) -- mais AUCUNE consequence de jeu :
//       le joueur decouvrira sa recolte prete au prochain /farm, aucune
//       perte economique, aucun etat incoherent.
//   (2) envoi PUIS claim : un crash entre les deux fait RENVOYER le
//       message au prochain tick (le joueur recoit un DM en double) --
//       gene mineure, mais AUCUNE fenetre ne garantit "jamais deux fois"
//       explicitement demandee plus haut pour ce point precis.
// Choix retenu : (1), car aucune consequence durable en cas de perte,
// contre une consequence (certes mineure) en cas de doublon avec (2). Une
// garantie exactly-once stricte des deux cotes necessiterait une file
// d'attente (outbox) persistante -- DELIBEREMENT NON CONSTRUITE ici (pas
// justifiee pour un DM informatif a faible enjeu) ; a reconsiderer
// seulement si un besoin reel de fiabilite plus stricte apparait.
export interface ClaimReadyPlotNotificationDeps {
  tryClaimNotifiedReady: (playerId: string, plotIndex: number, expectedPlantedAt: number) => Promise<boolean>;
}

async function realTryClaimNotifiedReady(
  playerId: string,
  plotIndex: number,
  expectedPlantedAt: number,
): Promise<boolean> {
  const { db } = await import("@workspace/db");
  const { plots } = await getSchemaTables();
  const updated = await db
    .update(plots)
    .set({ notifiedReady: true })
    .where(
      and(
        eq(plots.playerId, playerId),
        eq(plots.plotIndex, plotIndex),
        eq(plots.notifiedReady, false),
        isNotNull(plots.cropId),
        eq(plots.plantedAt, new Date(expectedPlantedAt)),
      ),
    )
    .returning({ id: plots.id });
  return updated.length > 0;
}

const realClaimReadyPlotNotificationDeps: ClaimReadyPlotNotificationDeps = {
  tryClaimNotifiedReady: realTryClaimNotifiedReady,
};

/**
 * Tente de reclamer atomiquement le droit d'envoyer la notification
 * "parcelle prete" pour `plotIndex` du joueur `playerId`, dont la
 * plantation en cours est cense avoir demarre a `expectedPlantedAt`
 * (epoch ms, observe par l'appelant).
 *
 * `readyAt` (epoch ms) est calcule par l'APPELANT a partir des regles
 * metier existantes (isReady()/growMinutes() de ../farm.ts, qui dependent
 * de player.irrigationLevel -- volontairement PAS dupliquees ici, cette
 * couche reste DB-only). Si `now < readyAt`, la parcelle n'est pas
 * (encore) prete : retourne `{ claimed: false }` IMMEDIATEMENT, sans
 * tenter la moindre ecriture -- c'est la verification "elle est
 * reellement prete" demandee, faite sur des donnees explicites plutot que
 * suppose vrai par confiance envers l'appelant.
 *
 * Si `now >= readyAt`, tente la transition atomique `notified_ready:
 * false -> true` en base. Retourne `{ claimed: true }` UNIQUEMENT si
 * cette transition a effectivement eu lieu -- deux appels concurrents
 * pour la MEME parcelle ne peuvent jamais tous les deux obtenir
 * `claimed: true`. N'envoie JAMAIS de message Discord elle-meme.
 */
export async function claimReadyPlotNotification(
  playerId: string,
  plotIndex: number,
  expectedPlantedAt: number,
  readyAt: number,
  now: number = Date.now(),
  deps: ClaimReadyPlotNotificationDeps = realClaimReadyPlotNotificationDeps,
): Promise<{ claimed: boolean }> {
  if (now < readyAt) {
    return { claimed: false };
  }
  const claimed = await deps.tryClaimNotifiedReady(playerId, plotIndex, expectedPlantedAt);
  return { claimed };
}
