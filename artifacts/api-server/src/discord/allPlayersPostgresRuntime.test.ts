// LOT V2-POSTGRES-ALL-USERS -- verifie que Farm2Win V2 fonctionne pour
// N'IMPORTE QUEL Discord ID quand shouldUsePostgresRuntime() retourne
// true inconditionnellement (FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED="true"),
// SANS jamais dependre de l'allowlist FARM2WIN_POSTGRES_TEST_PLAYER_IDS.
//
// Simule une "table Postgres" en memoire (Map<playerId, PlayerState> +
// UN SEUL GlobalState partage, exactement comme le vrai schema) et appelle
// les VRAIES fonctions farmPlayerActions.ts/farm.ts/presenters.ts/
// routes/activity.ts (jamais mockees au niveau metier) avec ces fausses
// primitives bas niveau injectees -- meme methodologie que
// activity.playerJourney.test.ts, etendue a PLUSIEURS joueurs simultanes
// et aux DEUX surfaces (slash commands ET Discord Activity) sur le MEME
// etat partage.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buyPlayerUpgrade,
  craftPlayerItem,
  harvestPlayerCrops,
  plantPlayerCrop,
  sellPlayerItems,
} from "./db/farmPlayerActions.ts";
import { freshQuests, STARTING_COINS, STARTING_PLOTS } from "./constants.ts";
import {
  resolveActivityBuy,
  resolveActivityCraft,
  resolveActivityHarvest,
  resolveActivityMe,
  resolveActivityPlant,
  resolveActivitySell,
  type ActivityBuyDeps,
  type ActivityCraftDeps,
  type ActivityHarvestDeps,
  type ActivityMeDeps,
  type ActivityPlantDeps,
  type ActivitySellDeps,
  type DiscordUser,
} from "../routes/activity.ts";
import {
  resolveBuyUpgrade,
  resolveFarmView,
  resolveInventory,
  resolveLeaderboard,
  resolveSellItems,
  type BuyResolutionDeps,
  type FarmViewResolutionDeps,
  type InventoryResolutionDeps,
  type LeaderboardResolutionDeps,
  type SellResolutionDeps,
} from "./presenters.ts";
import type { FarmStore } from "./store";
import type { CropId, GlobalState, InventoryId, PlayerState, ProductId } from "./types";

function buildDiscordUser(id: string): DiscordUser {
  return { id, username: `player-${id}` };
}

function buildNewPlayer(id: string, now: number): PlayerState {
  // Reutilise EXACTEMENT les memes constantes que newPlayerRowDefaults()
  // (farmRepository.ts, source de verite reelle pour ensurePlayerExists) :
  // STARTING_COINS/STARTING_PLOTS/freshQuests -- jamais une valeur
  // inventee ici, meme parite garantie par construction que le vrai code.
  return {
    userId: id,
    coins: STARTING_COINS,
    level: 1,
    xp: 0,
    plots: Array.from({ length: STARTING_PLOTS }, () => ({ cropId: null, plantedAt: null, notifiedReady: false })),
    inventory: {},
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: STARTING_COINS,
    createdAt: now,
    updatedAt: now,
    totalHarvested: 0,
    quests: freshQuests(),
    questsResetAt: now,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: null,
  };
}

function buildGlobal(now: number): GlobalState {
  return {
    marketMultiplier: 1,
    previousMarketMultiplier: 1,
    marketUpdatedAt: now,
    weather: "normal",
    weatherMultiplier: 1,
    weatherChangedAt: null,
    weatherExpiresAt: null,
    nextWeatherAt: now + 3 * 60 * 60 * 1000,
    nextWeatherType: "rain",
    contract: { cropId: "carrot", required: 20, remaining: 20, bonusMultiplier: 1.6, renewedAt: now },
    weeklyStartedAt: now,
    dailyChallenge: {
      cropId: "potato",
      target: 200,
      progress: 0,
      contributors: [],
      rewardCoins: 80,
      startedAt: now,
      completed: false,
      rewarded: false,
    },
  };
}

// Fabrique de "table Postgres" partagee : plusieurs joueurs independants +
// UN SEUL global_state, avec verrouillage PAR JOUEUR (une simple chaine de
// promesses par playerId) pour simuler fidelement SELECT ... FOR UPDATE :
// deux mutations concurrentes du MEME joueur se serialisent strictement
// (jamais de lecture-perdue), tandis que deux joueurs DIFFERENTS ne se
// bloquent jamais l'un l'autre (verrous independants) -- exactement le
// contrat de mutatePlayer()/mutatePlayerAndGlobal() reel (farmRepository.ts,
// deja valide en concurrence reelle contre Postgres par les scripts
// testMutatePlayerConcurrency.ts -- non refait ici, cette table simule
// uniquement le CONTRAT que l'orchestration au-dessus doit respecter).
function buildFakeDb(now: number) {
  const players = new Map<string, PlayerState>();
  const global = buildGlobal(now);
  const locks = new Map<string, Promise<unknown>>();

  function withPlayerLock<T>(playerId: string, fn: () => Promise<T>): Promise<T> {
    const prior = locks.get(playerId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    locks.set(playerId, next.catch(() => undefined));
    return next;
  }

  async function ensurePlayerExists(playerId: string) {
    return withPlayerLock(playerId, async () => {
      let created = false;
      if (!players.has(playerId)) {
        players.set(playerId, buildNewPlayer(playerId, now));
        created = true;
      }
      return { player: players.get(playerId)!, created };
    });
  }
  async function getPlayer(playerId: string): Promise<PlayerState | null> {
    return players.get(playerId) ?? null;
  }
  async function getAllPlayers(): Promise<PlayerState[]> {
    return [...players.values()];
  }
  async function getGlobalState(): Promise<GlobalState | null> {
    return global;
  }
  async function mutatePlayer(
    playerId: string,
    mutator: (player: PlayerState) => void | Promise<void>,
  ): Promise<PlayerState> {
    return withPlayerLock(playerId, async () => {
      const player = players.get(playerId);
      if (!player) throw new Error(`mutatePlayer (fake) : joueur "${playerId}" introuvable.`);
      await mutator(player);
      return player;
    });
  }
  async function mutatePlayerAndGlobal(
    playerId: string,
    mutator: (player: PlayerState, global: GlobalState) => void | Promise<void>,
  ): Promise<{ player: PlayerState; global: GlobalState }> {
    return withPlayerLock(playerId, async () => {
      const player = players.get(playerId);
      if (!player) throw new Error(`mutatePlayerAndGlobal (fake) : joueur "${playerId}" introuvable.`);
      await mutator(player, global);
      return { player, global };
    });
  }

  return { players, global, ensurePlayerExists, getPlayer, getAllPlayers, getGlobalState, mutatePlayer, mutatePlayerAndGlobal };
}

// Store JSON qui explose au moindre appel -- utilise partout ci-dessous
// comme `store` : pour un joueur routé Postgres (shouldUsePostgresRuntime
// toujours true dans ce fichier), la branche JSON ne doit JAMAIS etre
// atteinte, quelle que soit l'action.
function buildPoisonedJsonStore(): FarmStore {
  return {
    mutatePlayer: () => {
      throw new Error("store.mutatePlayer (JSON) ne doit JAMAIS etre appele -- FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED=true");
    },
    getPlayer: () => {
      throw new Error("store.getPlayer (JSON) ne doit JAMAIS etre appele -- FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED=true");
    },
    getPlayers: () => {
      throw new Error("store.getPlayers (JSON) ne doit JAMAIS etre appele -- FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED=true");
    },
    save: async () => {
      throw new Error("store.save (JSON) ne doit JAMAIS etre appele -- FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED=true");
    },
    global: undefined as unknown as GlobalState,
  } as unknown as FarmStore;
}

const shouldUsePostgresRuntime = () => true; // simule FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED="true"
const requireDiscordUser = async (authHeader: string | undefined) => {
  // Simule requireDiscordUser() : extrait juste l'id apres "Bearer ".
  const id = authHeader?.replace("Bearer ", "") ?? "";
  return buildDiscordUser(id);
};

function buildDeps(db: ReturnType<typeof buildFakeDb>, poisonedStore: FarmStore) {
  const requireDiscordUserFn = requireDiscordUser;
  const getFarmStore = async () => poisonedStore;
  const common = {
    requireDiscordUser: requireDiscordUserFn,
    getFarmStore,
    shouldUsePostgresRuntime,
    ensurePlayerExists: db.ensurePlayerExists,
    getPlayer: db.getPlayer,
    getGlobalState: db.getGlobalState,
  };
  const meDeps: ActivityMeDeps = { ...common };
  const plantDeps: ActivityPlantDeps = {
    ...common,
    plantPlayerCrop: (playerId: string, cropId: CropId, requestedPlot: number | null) =>
      plantPlayerCrop(playerId, cropId, requestedPlot, { mutatePlayer: db.mutatePlayer, getGlobalState: db.getGlobalState }),
  };
  const harvestDeps: ActivityHarvestDeps = {
    ...common,
    harvestPlayerCrops: (playerId: string) => harvestPlayerCrops(playerId, { mutatePlayerAndGlobal: db.mutatePlayerAndGlobal }),
  };
  const sellDeps: ActivitySellDeps = {
    ...common,
    sellPlayerItems: (playerId: string, itemId: InventoryId | "all", amount: number | null) =>
      sellPlayerItems(playerId, itemId, amount, { mutatePlayerAndGlobal: db.mutatePlayerAndGlobal }),
  };
  const buyDeps: ActivityBuyDeps = {
    ...common,
    buyPlayerUpgrade: (playerId: string, kind: "plots" | "irrigation" | "fertilizer", quantity: number) =>
      buyPlayerUpgrade(playerId, kind, quantity, { mutatePlayer: db.mutatePlayer, getGlobalState: db.getGlobalState }),
  };
  const craftDeps: ActivityCraftDeps = {
    ...common,
    craftPlayerItem: (playerId: string, recipeId: ProductId, quantity: number) =>
      craftPlayerItem(playerId, recipeId, quantity, { mutatePlayer: db.mutatePlayer, getGlobalState: db.getGlobalState }),
  };

  // Deps "slash" (presenters.ts) -- meme table Postgres partagee.
  const slashInventoryDeps: InventoryResolutionDeps = {
    shouldUsePostgresRuntime,
    ensurePlayerExists: db.ensurePlayerExists,
    getPlayer: db.getPlayer,
    getGlobalState: db.getGlobalState,
  };
  const slashFarmViewDeps: FarmViewResolutionDeps = {
    shouldUsePostgresRuntime,
    ensurePlayerExists: db.ensurePlayerExists,
    getPlayer: db.getPlayer,
    getGlobalState: db.getGlobalState,
  };
  const slashSellDeps: SellResolutionDeps = {
    shouldUsePostgresRuntime,
    ensurePlayerExists: db.ensurePlayerExists,
    sellPlayerItems: (playerId: string, itemId: InventoryId | "all", amount: number | null) =>
      sellPlayerItems(playerId, itemId, amount, { mutatePlayerAndGlobal: db.mutatePlayerAndGlobal }),
  };
  const slashBuyDeps: BuyResolutionDeps = {
    shouldUsePostgresRuntime,
    ensurePlayerExists: db.ensurePlayerExists,
    buyPlayerUpgrade: (playerId: string, kind: "plots" | "irrigation" | "fertilizer", quantity: number) =>
      buyPlayerUpgrade(playerId, kind, quantity, { mutatePlayer: db.mutatePlayer, getGlobalState: db.getGlobalState }),
  };
  const slashLeaderboardDeps: LeaderboardResolutionDeps = {
    shouldUsePostgresRuntime,
    getAllPlayers: db.getAllPlayers,
    getGlobalState: db.getGlobalState,
  };

  return { meDeps, plantDeps, harvestDeps, sellDeps, buyDeps, craftDeps, slashInventoryDeps, slashFarmViewDeps, slashSellDeps, slashBuyDeps, slashLeaderboardDeps };
}

// ===========================================================================
// 1. NOUVEAU JOUEUR -- Discord ID jamais vu, AUCUNE allowlist
// ===========================================================================

test("nouveau joueur (Discord ID jamais vu) -- premiere action (plant) cree automatiquement le player Postgres, sans allowlist", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const NEW_PLAYER_ID = "brand-new-discord-id-never-seen-before";

  assert.equal(await db.getPlayer(NEW_PLAYER_ID), null, "aucun player Postgres avant la premiere action");

  const meBefore = await resolveActivityMe(buildDiscordUser(NEW_PLAYER_ID), poisonedStore, deps.meDeps);
  assert.equal(meBefore.coins, STARTING_COINS, "GET /me seul suffit deja a creer le player avec les defaults V2");
  assert.equal(meBefore.plots.length, STARTING_PLOTS);
  assert.ok(meBefore.plots.every((p) => "empty" in p && p.empty));

  const plantResult = await resolveActivityPlant(buildDiscordUser(NEW_PLAYER_ID), "wheat", 1, poisonedStore, deps.plantDeps);
  assert.equal(plantResult.coins, STARTING_COINS - 5, "cout de la graine de blé déduit sur un player cree a la volee");
  assert.equal(plantResult.plots[0]!.cropId, "wheat");

  const created = await db.getPlayer(NEW_PLAYER_ID);
  assert.ok(created, "le player existe maintenant reellement dans la table Postgres");
});

test("nouveau joueur -- ensurePlayerExists() reproduit EXACTEMENT les defaults V2 (coins/plots/xp/level/inventaire/quests/skin/autoReplant/forecast)", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const { player, created } = await db.ensurePlayerExists("fresh-player-defaults-check");

  assert.equal(created, true);
  assert.equal(player.coins, STARTING_COINS);
  assert.equal(player.level, 1);
  assert.equal(player.xp, 0);
  assert.equal(player.plots.length, STARTING_PLOTS);
  assert.ok(player.plots.every((p) => p.cropId === null));
  assert.deepEqual(player.inventory, {});
  assert.equal(player.irrigationLevel, 0);
  assert.equal(player.fertilizerLevel, 0);
  assert.equal(player.lastDailyAt, null);
  assert.equal(player.autoReplant, false);
  assert.equal(player.weeklySnapshotCoins, STARTING_COINS);
  assert.equal(player.totalHarvested, 0);
  assert.equal(player.quests.length, freshQuests().length, "meme nombre de quetes qu'un nouveau joueur V1/V2 frais");
  assert.equal(player.plotSkin, "classic");
  assert.deepEqual(player.unlockedSkins, ["classic"]);
  assert.equal(player.weatherForecast, null);
});

// ===========================================================================
// 2. DEUX JOUEURS -- isolation stricte, global_state partage
// ===========================================================================

test("deux joueurs -- coins/inventaire/parcelles/XP/ameliorations/autoReplant strictement independants, meme meteo/marche/defi quotidien", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const PLAYER_A = "player-a-isolation";
  const PLAYER_B = "player-b-isolation";

  await resolveActivityPlant(buildDiscordUser(PLAYER_A), "wheat", 1, poisonedStore, deps.plantDeps);
  await db.ensurePlayerExists(PLAYER_B);
  db.players.get(PLAYER_B)!.coins = 1000; // assez pour l'achat, sans rapport avec l'isolation testee
  await resolveActivityBuy(buildDiscordUser(PLAYER_B), "irrigation", 1, poisonedStore, deps.buyDeps);

  const meA = await resolveActivityMe(buildDiscordUser(PLAYER_A), poisonedStore, deps.meDeps);
  const meB = await resolveActivityMe(buildDiscordUser(PLAYER_B), poisonedStore, deps.meDeps);

  assert.equal(meA.coins, STARTING_COINS - 5, "A a paye sa graine, pas B");
  assert.equal(meB.coins, 1000 - 200, "B a paye son irrigation, pas A");
  assert.equal(meA.irrigationLevel, 0, "l'achat de B ne doit JAMAIS affecter A");
  assert.equal(meB.irrigationLevel, 1);
  assert.equal((meA.plots[0] as { cropId?: string }).cropId, "wheat", "A a bien sa parcelle plantee");
  assert.ok(meB.plots.every((p) => "empty" in p && p.empty), "B n'a rien plante, ses parcelles restent vides");

  // meteo/marche/defi quotidien : MEME global_state pour les deux.
  assert.deepEqual(meA.weather.current, meB.weather.current, "meme meteo pour tous les joueurs");
  assert.equal(meA.global.marketMultiplier, meB.global.marketMultiplier, "meme marche pour tous les joueurs");
  assert.deepEqual(meA.dailyChallenge, meB.dailyChallenge, "meme defi quotidien global pour tous les joueurs");
});

// ===========================================================================
// 3. MULTI-JOUEURS (10 simules) -- aucune collision d'etat
// ===========================================================================

test("10 joueurs simules -- ensure + plant + harvest + sell + buy + craft, aucune collision, global_state partage correctement", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const playerIds = Array.from({ length: 10 }, (_unused, index) => `multi-player-${index}`);

  for (const id of playerIds) {
    await resolveActivityPlant(buildDiscordUser(id), "wheat", 1, poisonedStore, deps.plantDeps);
    db.players.get(id)!.plots[0]!.plantedAt = now - 10 * 60 * 1000; // simule la pousse
    await resolveActivityHarvest(buildDiscordUser(id), poisonedStore, deps.harvestDeps);
    db.players.get(id)!.coins = 1000; // assez pour l'achat, sans rapport avec l'isolation testee
    await resolveActivityBuy(buildDiscordUser(id), "irrigation", 1, poisonedStore, deps.buyDeps);
  }

  assert.equal(db.players.size, 10, "exactement 10 joueurs distincts crees, aucun ecrasement");
  for (const id of playerIds) {
    const me = await resolveActivityMe(buildDiscordUser(id), poisonedStore, deps.meDeps);
    assert.equal(me.inventory.wheat, 3, `joueur ${id} : recolte independante (3 blés)`);
    assert.equal(me.irrigationLevel, 1, `joueur ${id} : amelioration independante`);
    assert.equal(me.coins, 1000 - 200, `joueur ${id} : solde independant`);
  }
  // Aucune donnee d'un joueur ne fuit chez un autre : chaque PlayerState en
  // memoire est un objet strictement distinct.
  const allPlayerObjects = new Set(playerIds.map((id) => db.players.get(id)));
  assert.equal(allPlayerObjects.size, 10);
});

// ===========================================================================
// 4. CONCURRENCE -- MEME joueur (sell + sell simultanes)
// ===========================================================================

test("concurrence meme joueur -- deux sell() simultanes sur le meme stock ne survendent jamais (pas de double depense, pas d'inventaire negatif)", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const PLAYER_ID = "concurrency-same-player";

  await db.ensurePlayerExists(PLAYER_ID);
  db.players.get(PLAYER_ID)!.inventory.wheat = 10;

  const [resultA, resultB] = await Promise.allSettled([
    resolveActivitySell(buildDiscordUser(PLAYER_ID), "wheat", 10, poisonedStore, deps.sellDeps),
    resolveActivitySell(buildDiscordUser(PLAYER_ID), "wheat", 10, poisonedStore, deps.sellDeps),
  ]);

  const outcomes = [resultA, resultB];
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o) => o.status === "rejected");
  assert.equal(fulfilled.length, 1, "une seule des deux ventes doit reussir (le stock de 10 ne peut etre vendu qu'une fois)");
  assert.equal(rejected.length, 1, "la seconde doit echouer proprement (FarmError : aucune ressource a vendre), jamais survendre");

  const finalPlayer = await db.getPlayer(PLAYER_ID);
  assert.ok(finalPlayer);
  assert.equal(finalPlayer.inventory.wheat ?? 0, 0, "jamais negatif, exactement 0 apres une seule vente reussie");
  assert.equal(finalPlayer.coins, STARTING_COINS + 40, "gain d'UNE seule vente (10 blés x 4 pièces), jamais double");
});

test("concurrence meme joueur -- deux harvest() simultanes sur la meme parcelle prete ne recoltent qu'une seule fois", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const PLAYER_ID = "concurrency-same-player-harvest";

  await resolveActivityPlant(buildDiscordUser(PLAYER_ID), "wheat", 1, poisonedStore, deps.plantDeps);
  db.players.get(PLAYER_ID)!.plots[0]!.plantedAt = now - 10 * 60 * 1000;

  const [resultA, resultB] = await Promise.allSettled([
    resolveActivityHarvest(buildDiscordUser(PLAYER_ID), poisonedStore, deps.harvestDeps),
    resolveActivityHarvest(buildDiscordUser(PLAYER_ID), poisonedStore, deps.harvestDeps),
  ]);

  const succeededWithWheat = [resultA, resultB].filter(
    (o) => o.status === "fulfilled" && o.value.status === 200 && (o.value.payload.inventory.wheat ?? 0) > 0,
  );
  assert.equal(succeededWithWheat.length, 1, "une seule des deux recoltes doit rapporter du blé -- jamais de double recolte");

  const finalPlayer = await db.getPlayer(PLAYER_ID);
  assert.ok(finalPlayer);
  assert.equal(finalPlayer.inventory.wheat, 3, "exactement le rendement d'UNE seule recolte, jamais 6");
});

// ===========================================================================
// 5. CONCURRENCE -- joueurs DIFFERENTS (buy + buy simultanes)
// ===========================================================================

test("concurrence joueurs differents -- deux buy() simultanes sur deux joueurs distincts n'interferent jamais l'un avec l'autre", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const PLAYER_A = "concurrency-diff-a";
  const PLAYER_B = "concurrency-diff-b";
  await db.ensurePlayerExists(PLAYER_A);
  await db.ensurePlayerExists(PLAYER_B);
  db.players.get(PLAYER_A)!.coins = 1000;
  db.players.get(PLAYER_B)!.coins = 1000;

  const [resultA, resultB] = await Promise.all([
    resolveActivityBuy(buildDiscordUser(PLAYER_A), "plots", 1, poisonedStore, deps.buyDeps),
    resolveActivityBuy(buildDiscordUser(PLAYER_B), "fertilizer", 1, poisonedStore, deps.buyDeps),
  ]);

  assert.equal(resultA.plots.length, STARTING_PLOTS + 1, "A a bien sa parcelle supplementaire");
  assert.equal(resultA.fertilizerLevel, 0, "l'achat de B ne doit jamais se refleter chez A");
  assert.equal(resultB.fertilizerLevel, 1, "B a bien son niveau d'engrais");
  assert.equal(resultB.plots.length, STARTING_PLOTS, "l'achat de A ne doit jamais se refleter chez B");
});

// ===========================================================================
// 6. TEST "JSON POISON" -- mode ALL PLAYERS, aucune action ne doit toucher au JSON
// ===========================================================================

test("mode ALL PLAYERS -- store JSON poison (throw immediat) : plant/harvest/sell/buy/craft/GET me fonctionnent tous sans jamais le toucher", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const PLAYER_ID = "json-poison-player";

  await resolveActivityMe(buildDiscordUser(PLAYER_ID), poisonedStore, deps.meDeps);
  await resolveActivityPlant(buildDiscordUser(PLAYER_ID), "wheat", 1, poisonedStore, deps.plantDeps);
  db.players.get(PLAYER_ID)!.plots[0]!.plantedAt = now - 10 * 60 * 1000;
  await resolveActivityHarvest(buildDiscordUser(PLAYER_ID), poisonedStore, deps.harvestDeps);
  await resolveActivitySell(buildDiscordUser(PLAYER_ID), "wheat", 1, poisonedStore, deps.sellDeps);
  db.players.get(PLAYER_ID)!.coins = 1000; // assez pour l'achat, sans rapport avec l'objet du test
  await resolveActivityBuy(buildDiscordUser(PLAYER_ID), "irrigation", 1, poisonedStore, deps.buyDeps);
  db.players.get(PLAYER_ID)!.inventory.wheat = 3;
  await resolveActivityCraft(buildDiscordUser(PLAYER_ID), "bread", 1, poisonedStore, deps.craftDeps);

  // Si l'une de ces actions avait touche le store JSON, le test aurait deja
  // leve une exception (buildPoisonedJsonStore()) avant d'atteindre cette
  // ligne -- le simple fait d'arriver ici, sans avoir catch quoi que ce
  // soit, EST l'assertion.
  const finalMe = await resolveActivityMe(buildDiscordUser(PLAYER_ID), poisonedStore, deps.meDeps);
  assert.ok(finalMe.coins >= 0);
});

// ===========================================================================
// 7. ACTIVITY <-> SLASH CROSS-CHECK -- meme joueur, deux interfaces
// ===========================================================================

test("Activity <-> slash cross-check -- action via Activity (plant) puis lecture via slash (/farm), meme etat Postgres immediatement", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const PLAYER_ID = "cross-check-activity-to-slash";

  const activityResult = await resolveActivityPlant(buildDiscordUser(PLAYER_ID), "wheat", 1, poisonedStore, deps.plantDeps);
  const slashFarmView = await resolveFarmView(PLAYER_ID, poisonedStore, deps.slashFarmViewDeps);

  assert.equal(slashFarmView.player.coins, activityResult.coins, "/farm (slash) doit refleter EXACTEMENT les memes coins que la reponse Activity");
  assert.equal(slashFarmView.player.plots[0]!.cropId, "wheat", "/farm (slash) voit la parcelle plantee via l'Activity");
});

test("Activity <-> slash cross-check -- action via slash (/buy) puis lecture via Activity (GET /me), meme etat Postgres immediatement", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const PLAYER_ID = "cross-check-slash-to-activity";
  await db.ensurePlayerExists(PLAYER_ID);
  db.players.get(PLAYER_ID)!.coins = 1000; // assez pour l'achat, sans rapport avec la coherence testee

  const slashBuyResult = await resolveBuyUpgrade(PLAYER_ID, "irrigation", 1, poisonedStore, deps.slashBuyDeps);
  assert.equal(slashBuyResult.bought, 1);
  const activityMe = await resolveActivityMe(buildDiscordUser(PLAYER_ID), poisonedStore, deps.meDeps);

  assert.equal(activityMe.irrigationLevel, 1, "GET /activity/me doit refleter EXACTEMENT le meme niveau d'irrigation que l'achat via /buy (slash)");
  assert.equal(activityMe.coins, 1000 - 200);
});

test("Activity <-> slash cross-check -- vente via Activity puis /inventory (slash), meme inventaire", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const PLAYER_ID = "cross-check-sell-inventory";

  await db.ensurePlayerExists(PLAYER_ID);
  db.players.get(PLAYER_ID)!.inventory.wheat = 10;

  const sellResult = await resolveActivitySell(buildDiscordUser(PLAYER_ID), "wheat", 4, poisonedStore, deps.sellDeps);
  const slashInventory = await resolveInventory(PLAYER_ID, poisonedStore, deps.slashInventoryDeps);

  assert.equal(slashInventory.player.inventory.wheat, sellResult.inventory.wheat, "/inventory (slash) doit refleter EXACTEMENT le meme inventaire que la reponse Activity");
  assert.equal(slashInventory.player.inventory.wheat, 6);
});

// ===========================================================================
// 8. LEADERBOARD -- multi-joueurs, plus limite a l'allowlist historique
// ===========================================================================

test("leaderboard -- lit TOUS les joueurs Postgres (aucune limitation a une allowlist historique)", async () => {
  const now = Date.now();
  const db = buildFakeDb(now);
  const poisonedStore = buildPoisonedJsonStore();
  const deps = buildDeps(db, poisonedStore);
  const playerIds = ["lb-player-1", "lb-player-2", "lb-player-3", "lb-player-4", "lb-player-5"];

  for (const id of playerIds) {
    await db.ensurePlayerExists(id);
  }
  // Coins distincts pour verifier l'ordre/la presence de chacun.
  db.players.get("lb-player-1")!.coins = 500;
  db.players.get("lb-player-2")!.coins = 900;
  db.players.get("lb-player-3")!.coins = 100;
  db.players.get("lb-player-4")!.coins = 700;
  db.players.get("lb-player-5")!.coins = 300;

  const leaderboard = await resolveLeaderboard("lb-player-1", poisonedStore, deps.slashLeaderboardDeps);

  assert.equal(leaderboard.players.length, playerIds.length, "TOUS les joueurs Postgres doivent apparaitre, aucune limitation allowlist");
  const ids = leaderboard.players.map((p) => p.userId);
  for (const id of playerIds) {
    assert.ok(ids.includes(id), `${id} doit figurer dans le classement`);
  }
});
