// Tests de presenters.ts -- LOT 6, UNIQUEMENT le branchement PostgreSQL de
// /buy (resolveBuyUpgrade), /daily (resolveDailyClaim), /plant
// (resolvePlantCrop), /craft (resolveCraftItem), /harvest
// (resolveHarvestCrops) et /sell (resolveSellItems), plus le garde-fou de
// preambule (commandSkipsJsonPreamble). N'importe jamais discord.js comme
// valeur d'execution pour les tests resolveBuyUpgrade/resolveDailyClaim/
// resolvePlantCrop/resolveCraftItem/resolveHarvestCrops/resolveSellItems
// (ni fausse ChatInputCommandInteraction) : ces fonctions ont ete
// extraites de commandBuy()/commandDaily()/commandPlant()/commandCraft()/
// commandHarvest()/commandSell() precisement pour rester testables ainsi --
// seule la DECISION (V1 vs Postgres, quel resultat) est exercee ici. Le
// parsing des options et la construction de l'embed Discord restent dans
// ces command*(), inchanges, non couverts par ce fichier (aucune regle
// metier n'y est ajoutee ni testee a nouveau). Une fausse interaction
// minimale N'EST construite QUE pour le test "list" de handleSlashCommand
// (commande sans donnee joueur, jamais de connexion DB).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import { FarmError, currentCropPrice, growMinutes, growthPercent, isReady, productPrice, totalInventoryValue, xpToNextLevel } from "./farm.ts";
import type { ChatInputCommandInteraction } from "discord.js";
import {
  commandSkipsJsonPreamble,
  handleSlashCommand,
  resolveBuyUpgrade,
  resolveCraftItem,
  resolveDailyClaim,
  resolveFarmView,
  resolveHarvestCrops,
  resolveInventory,
  resolveMarket,
  resolvePlantCrop,
  resolveProfile,
  resolveSellItems,
  type BuyResolutionDeps,
  type CraftResolutionDeps,
  type DailyResolutionDeps,
  type FarmViewResolutionDeps,
  type HarvestResolutionDeps,
  type InventoryResolutionDeps,
  type MarketResolutionDeps,
  type PlantResolutionDeps,
  type ProfileResolutionDeps,
  type SellResolutionDeps,
} from "./presenters.ts";
import { POSTGRES_TEST_PLAYER_IDS_ENV_VAR, shouldUsePostgresRuntime } from "./postgresRuntimeAllowlist.ts";
import { FarmStore } from "./store.ts";
import { defaultGlobalState } from "./constants.ts";
import type { GlobalState, PlayerState } from "./types";

const TEST_PLAYER_ID = "v2-test-player-001";

function buildPlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    userId: TEST_PLAYER_ID,
    coins: 1000,
    level: 1,
    xp: 0,
    plots: [],
    inventory: {},
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: 1000,
    createdAt: 0,
    updatedAt: 0,
    totalHarvested: 0,
    quests: [],
    questsResetAt: 0,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: null,
    ...overrides,
  };
}

// Cast minimal volontaire (meme convention que FAKE_TX ailleurs dans ce
// depot) : seul mutatePlayer() est jamais appele par resolveBuyUpgrade().
function buildFakeStore(mutatePlayer: FarmStore["mutatePlayer"]): FarmStore {
  return { mutatePlayer } as unknown as FarmStore;
}

// Variante pour resolvePlantCrop : le chemin V1 de /plant appelle AUSSI
// store.getPlayer() (synchrone) apres la mutation, exactement comme avant
// ce lot -- voir le commentaire de resolvePlantCrop dans presenters.ts.
function buildFakeStoreForPlant(
  mutatePlayer: FarmStore["mutatePlayer"],
  getPlayer: FarmStore["getPlayer"],
): FarmStore {
  return { mutatePlayer, getPlayer } as unknown as FarmStore;
}

const NOW = 1_700_000_000_000;

function buildGlobalState(overrides: Partial<GlobalState> = {}): GlobalState {
  return {
    marketMultiplier: 1,
    previousMarketMultiplier: 1,
    marketUpdatedAt: NOW,
    weather: "normal",
    weatherMultiplier: 1,
    weatherChangedAt: null,
    weatherExpiresAt: null,
    nextWeatherAt: NOW,
    nextWeatherType: "rain",
    contract: { cropId: "wheat", required: 20, remaining: 20, bonusMultiplier: 1.6, renewedAt: NOW },
    weeklyStartedAt: NOW,
    dailyChallenge: {
      cropId: "wheat",
      target: 200,
      progress: 0,
      contributors: [],
      rewardCoins: 80,
      startedAt: NOW,
      completed: false,
      rewarded: false,
    },
    ...overrides,
  };
}

// Variante pour resolveHarvestCrops : le chemin V1 de /harvest lit ET mute
// store.global directement (harvest() y ecrit la progression du defi) --
// voir le commentaire de resolveHarvestCrops dans presenters.ts.
function buildFakeStoreForHarvest(mutatePlayer: FarmStore["mutatePlayer"], global: GlobalState): FarmStore {
  return { mutatePlayer, global } as unknown as FarmStore;
}

// Variante pour resolveInventory : /inventory est PUREMENT LECTURE SEULE --
// le chemin V1 n'appelle jamais mutatePlayer, seulement store.getPlayer()
// (synchrone, comme dans commandInventory avant ce lot) et store.global.
function buildFakeStoreForInventory(getPlayer: FarmStore["getPlayer"], global: GlobalState): FarmStore {
  return { getPlayer, global } as unknown as FarmStore;
}

function buildDeps(overrides: Partial<BuyResolutionDeps> = {}): BuyResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    buyPlayerUpgrade: async () => ({ bought: 1, spent: 200 }),
    ...overrides,
  };
}

test("resolveBuyUpgrade A. joueur non allowliste : utilise store.mutatePlayer, jamais ensurePlayerExists/buyPlayerUpgrade, meme regle V1 (cout reel de buyUpgrade)", async () => {
  const player = buildPlayerState();
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
  const buyPlayerUpgrade = mock.fn(async () => ({ bought: 99, spent: 99 }));
  const deps = buildDeps({ shouldUsePostgresRuntime: () => false, ensurePlayerExists, buyPlayerUpgrade });

  const result = await resolveBuyUpgrade(TEST_PLAYER_ID, "irrigation", 1, store, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(buyPlayerUpgrade.mock.calls.length, 0);
  // buyUpgrade("irrigation", niveau 0) reel de farm.ts : cout Math.round(200*1.45^0)=200 -- regle V1 inchangee.
  assert.deepEqual(result, { bought: 1, spent: 200 });
  assert.equal(player.irrigationLevel, 1);
  assert.equal(player.coins, 800);
});

test("resolveBuyUpgrade B. joueur allowliste existant : ensurePlayerExists + buyPlayerUpgrade avec le bon playerId/kind/quantite, jamais store.mutatePlayer", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer ne doit jamais etre appele sur le chemin Postgres");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const buyPlayerUpgrade = mock.fn(async () => ({ bought: 3, spent: 450 }));
  const deps = buildDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, buyPlayerUpgrade });

  const result = await resolveBuyUpgrade(TEST_PLAYER_ID, "plots", 3, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(buyPlayerUpgrade.mock.calls.length, 1);
  assert.deepEqual(buyPlayerUpgrade.mock.calls[0]!.arguments, [TEST_PLAYER_ID, "plots", 3]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
  assert.deepEqual(result, { bought: 3, spent: 450 });
});

test("resolveBuyUpgrade C. joueur allowliste absent : bootstrap (created=true) PUIS buyPlayerUpgrade, aucun chemin JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const buyPlayerUpgrade = mock.fn(async () => {
    callOrder.push("buy");
    return { bought: 1, spent: 200 };
  });
  const deps = buildDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, buyPlayerUpgrade });

  await resolveBuyUpgrade(TEST_PLAYER_ID, "irrigation", 1, store, deps);

  assert.deepEqual(callOrder, ["ensure", "buy"]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
});

test("resolveBuyUpgrade D. erreur metier Postgres : FarmError propagee telle quelle, aucun fallback silencieux vers JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun fallback JSON attendu apres une erreur Postgres");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const buyPlayerUpgrade = mock.fn(async () => {
    throw new FarmError("Achat impossible : niveau maximum atteint ou pièces insuffisantes.");
  });
  const deps = buildDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, buyPlayerUpgrade });

  await assert.rejects(
    () => resolveBuyUpgrade(TEST_PLAYER_ID, "irrigation", 1, store, deps),
    (error: unknown) => error instanceof FarmError,
  );
  assert.equal(mutatePlayer.mock.calls.length, 0, "aucun fallback silencieux vers JSON apres une erreur Postgres");
});

test("resolveBuyUpgrade E. env FARM2WIN_POSTGRES_TEST_PLAYER_IDS absente, avec la VRAIE shouldUsePostgresRuntime (non mockee) : comportement V1 par defaut", async () => {
  const originalEnv = process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
  try {
    delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    const player = buildPlayerState();
    const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
      mutator(player);
      return player;
    });
    const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
    const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
    const buyPlayerUpgrade = mock.fn(async () => ({ bought: 999, spent: 999 }));

    const result = await resolveBuyUpgrade(TEST_PLAYER_ID, "irrigation", 1, store, {
      shouldUsePostgresRuntime, // la VRAIE fonction importee, pas un mock
      ensurePlayerExists,
      buyPlayerUpgrade,
    });

    assert.equal(mutatePlayer.mock.calls.length, 1);
    assert.equal(ensurePlayerExists.mock.calls.length, 0);
    assert.equal(buyPlayerUpgrade.mock.calls.length, 0);
    assert.equal(result.spent, 200);
  } finally {
    if (originalEnv === undefined) delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    else process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR] = originalEnv;
  }
});

// ===========================================================================
// resolveDailyClaim -- meme structure que resolveBuyUpgrade ci-dessus.
// ===========================================================================

function buildDailyDeps(overrides: Partial<DailyResolutionDeps> = {}): DailyResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    claimPlayerDaily: async () => 42,
    ...overrides,
  };
}

test("resolveDailyClaim A. joueur non allowliste : utilise store.mutatePlayer, jamais ensurePlayerExists/claimPlayerDaily, meme regle V1 (recompense reelle de claimDaily)", async () => {
  const player = buildPlayerState({ level: 3, coins: 0, lastDailyAt: null });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
  const claimPlayerDaily = mock.fn(async () => 999);
  const deps = buildDailyDeps({ shouldUsePostgresRuntime: () => false, ensurePlayerExists, claimPlayerDaily });

  const reward = await resolveDailyClaim(TEST_PLAYER_ID, store, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(claimPlayerDaily.mock.calls.length, 0);
  // claimDaily(niveau 3) reel de farm.ts : recompense = 40 + 3*2 = 46 -- regle V1 inchangee.
  assert.equal(reward, 46);
  assert.equal(player.coins, 46);
});

test("resolveDailyClaim B. joueur allowliste existant : ensurePlayerExists + claimPlayerDaily avec le bon playerId, jamais store.mutatePlayer", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer ne doit jamais etre appele sur le chemin Postgres");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const claimPlayerDaily = mock.fn(async () => 46);
  const deps = buildDailyDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, claimPlayerDaily });

  const reward = await resolveDailyClaim(TEST_PLAYER_ID, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(claimPlayerDaily.mock.calls.length, 1);
  assert.deepEqual(claimPlayerDaily.mock.calls[0]!.arguments, [TEST_PLAYER_ID]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
  assert.equal(reward, 46);
});

test("resolveDailyClaim C. joueur allowliste absent : bootstrap (created=true) PUIS claimPlayerDaily, aucun chemin JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const claimPlayerDaily = mock.fn(async () => {
    callOrder.push("daily");
    return 42;
  });
  const deps = buildDailyDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, claimPlayerDaily });

  await resolveDailyClaim(TEST_PLAYER_ID, store, deps);

  assert.deepEqual(callOrder, ["ensure", "daily"]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
});

test("resolveDailyClaim D. cooldown Postgres : FarmError propagee telle quelle, aucun fallback silencieux vers JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun fallback JSON attendu apres une erreur Postgres");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const claimPlayerDaily = mock.fn(async () => {
    throw new FarmError("Ta récompense revient dans environ 5 h.");
  });
  const deps = buildDailyDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, claimPlayerDaily });

  await assert.rejects(
    () => resolveDailyClaim(TEST_PLAYER_ID, store, deps),
    (error: unknown) => error instanceof FarmError,
  );
  assert.equal(mutatePlayer.mock.calls.length, 0, "aucun fallback silencieux vers JSON apres une erreur Postgres");
});

test("resolveDailyClaim E. env FARM2WIN_POSTGRES_TEST_PLAYER_IDS absente, avec la VRAIE shouldUsePostgresRuntime (non mockee) : comportement V1 par defaut", async () => {
  const originalEnv = process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
  try {
    delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    const player = buildPlayerState({ level: 1, lastDailyAt: null });
    const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
      mutator(player);
      return player;
    });
    const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
    const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
    const claimPlayerDaily = mock.fn(async () => 999);

    const reward = await resolveDailyClaim(TEST_PLAYER_ID, store, {
      shouldUsePostgresRuntime, // la VRAIE fonction importee, pas un mock
      ensurePlayerExists,
      claimPlayerDaily,
    });

    assert.equal(mutatePlayer.mock.calls.length, 1);
    assert.equal(ensurePlayerExists.mock.calls.length, 0);
    assert.equal(claimPlayerDaily.mock.calls.length, 0);
    assert.equal(reward, 42); // 40 + niveau(1)*2
  } finally {
    if (originalEnv === undefined) delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    else process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR] = originalEnv;
  }
});

// ===========================================================================
// resolvePlantCrop -- meme structure que resolveBuyUpgrade/resolveDailyClaim
// ci-dessus, avec une nuance : la reponse Discord a besoin d'une SECONDE
// donnee (irrigationLevel, pour growMinutes()) en plus du numero de
// parcelle -- voir le commentaire de resolvePlantCrop dans presenters.ts.
// ===========================================================================

function buildPlantDeps(overrides: Partial<PlantResolutionDeps> = {}): PlantResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    plantPlayerCrop: async () => 1,
    getPlayer: async (playerId: string) => buildPlayerState({ userId: playerId }),
    ...overrides,
  };
}

test("resolvePlantCrop A. joueur non allowliste : utilise store.mutatePlayer + store.getPlayer, jamais ensurePlayerExists/plantPlayerCrop, meme regle V1 (plant reel de farm.ts)", async () => {
  const player = buildPlayerState({
    coins: 1000,
    irrigationLevel: 4,
    plots: [{ cropId: null, plantedAt: null, notifiedReady: false }],
  });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const getPlayer = mock.fn(() => player);
  const store = buildFakeStoreForPlant(mutatePlayer as unknown as FarmStore["mutatePlayer"], getPlayer as unknown as FarmStore["getPlayer"]);
  const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
  const plantPlayerCrop = mock.fn(async () => 99);
  const deps = buildPlantDeps({ shouldUsePostgresRuntime: () => false, ensurePlayerExists, plantPlayerCrop });

  const result = await resolvePlantCrop(TEST_PLAYER_ID, "wheat", null, store, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(getPlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(plantPlayerCrop.mock.calls.length, 0);
  // plant() reel de farm.ts : parcelle 1 (premiere libre), regle V1 inchangee.
  assert.equal(result.plantedPlot, 1);
  assert.equal(result.player.plots[0]!.cropId, "wheat");
  assert.equal(result.player.irrigationLevel, 4);
});

test("resolvePlantCrop B. joueur allowliste existant : ensurePlayerExists + plantPlayerCrop + getPlayer(repository), jamais store.mutatePlayer/store.getPlayer", async () => {
  const storeGetPlayer = mock.fn(() => {
    throw new Error("store.getPlayer ne doit jamais etre appele sur le chemin Postgres");
  });
  const mutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer ne doit jamais etre appele sur le chemin Postgres");
  });
  const store = buildFakeStoreForPlant(mutatePlayer as unknown as FarmStore["mutatePlayer"], storeGetPlayer as unknown as FarmStore["getPlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const plantPlayerCrop = mock.fn(async () => 2);
  const getPlayer = mock.fn(async (playerId: string) => buildPlayerState({ userId: playerId, irrigationLevel: 7 }));
  const deps = buildPlantDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, plantPlayerCrop, getPlayer });

  const result = await resolvePlantCrop(TEST_PLAYER_ID, "wheat", 2, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(plantPlayerCrop.mock.calls.length, 1);
  assert.deepEqual(plantPlayerCrop.mock.calls[0]!.arguments, [TEST_PLAYER_ID, "wheat", 2]);
  assert.equal(getPlayer.mock.calls.length, 1);
  assert.equal(getPlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(mutatePlayer.mock.calls.length, 0);
  assert.equal(storeGetPlayer.mock.calls.length, 0);
  assert.equal(result.plantedPlot, 2);
  assert.equal(result.player.irrigationLevel, 7);
});

test("resolvePlantCrop C. joueur allowliste absent : bootstrap (created=true) PUIS plantPlayerCrop PUIS getPlayer(repository), aucun chemin JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
  });
  const store = buildFakeStoreForPlant(mutatePlayer as unknown as FarmStore["mutatePlayer"], (() => {
    throw new Error("store.getPlayer ne doit jamais etre appele sur le chemin Postgres");
  }) as unknown as FarmStore["getPlayer"]);
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const plantPlayerCrop = mock.fn(async () => {
    callOrder.push("plant");
    return 1;
  });
  const getPlayer = mock.fn(async (playerId: string) => {
    callOrder.push("getPlayer");
    return buildPlayerState({ userId: playerId });
  });
  const deps = buildPlantDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, plantPlayerCrop, getPlayer });

  await resolvePlantCrop(TEST_PLAYER_ID, "wheat", null, store, deps);

  assert.deepEqual(callOrder, ["ensure", "plant", "getPlayer"]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
});

test("resolvePlantCrop D. erreur metier Postgres : FarmError propagee telle quelle, aucun fallback silencieux vers JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun fallback JSON attendu apres une erreur Postgres");
  });
  const store = buildFakeStoreForPlant(mutatePlayer as unknown as FarmStore["mutatePlayer"], (() => null) as unknown as FarmStore["getPlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const plantPlayerCrop = mock.fn(async () => {
    throw new FarmError("La parcelle 1 est déjà occupée.");
  });
  const getPlayer = mock.fn(async (playerId: string) => buildPlayerState({ userId: playerId }));
  const deps = buildPlantDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, plantPlayerCrop, getPlayer });

  await assert.rejects(
    () => resolvePlantCrop(TEST_PLAYER_ID, "wheat", 1, store, deps),
    (error: unknown) => error instanceof FarmError,
  );
  assert.equal(mutatePlayer.mock.calls.length, 0, "aucun fallback silencieux vers JSON apres une erreur Postgres");
  assert.equal(getPlayer.mock.calls.length, 0, "getPlayer(repository) ne doit pas etre tente si plantPlayerCrop a echoue");
});

test("resolvePlantCrop E. env FARM2WIN_POSTGRES_TEST_PLAYER_IDS absente, avec la VRAIE shouldUsePostgresRuntime (non mockee) : comportement V1 par defaut", async () => {
  const originalEnv = process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
  try {
    delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    const player = buildPlayerState({ plots: [{ cropId: null, plantedAt: null, notifiedReady: false }] });
    const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
      mutator(player);
      return player;
    });
    const getPlayer = mock.fn(() => player);
    const store = buildFakeStoreForPlant(mutatePlayer as unknown as FarmStore["mutatePlayer"], getPlayer as unknown as FarmStore["getPlayer"]);
    const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
    const plantPlayerCrop = mock.fn(async () => 999);

    const result = await resolvePlantCrop(TEST_PLAYER_ID, "wheat", null, store, {
      shouldUsePostgresRuntime, // la VRAIE fonction importee, pas un mock
      ensurePlayerExists,
      plantPlayerCrop,
      getPlayer: async () => {
        throw new Error("getPlayer(repository) ne doit jamais etre appele en V1");
      },
    });

    assert.equal(mutatePlayer.mock.calls.length, 1);
    assert.equal(ensurePlayerExists.mock.calls.length, 0);
    assert.equal(plantPlayerCrop.mock.calls.length, 0);
    assert.equal(result.plantedPlot, 1);
  } finally {
    if (originalEnv === undefined) delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    else process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR] = originalEnv;
  }
});

test("resolvePlantCrop F. reponse : le temps de pousse (growMinutes) calcule a partir du player retourne est identique V1/Postgres pour la meme irrigationLevel", async () => {
  const v1Player = buildPlayerState({
    irrigationLevel: 6,
    plots: [{ cropId: null, plantedAt: null, notifiedReady: false }],
  });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(v1Player);
    return v1Player;
  });
  const getPlayer = mock.fn(() => v1Player);
  const store = buildFakeStoreForPlant(mutatePlayer as unknown as FarmStore["mutatePlayer"], getPlayer as unknown as FarmStore["getPlayer"]);
  const v1Result = await resolvePlantCrop(
    TEST_PLAYER_ID,
    "wheat",
    null,
    store,
    buildPlantDeps({ shouldUsePostgresRuntime: () => false }),
  );

  const pgPlayer = buildPlayerState({ irrigationLevel: 6 });
  const pgResult = await resolvePlantCrop(
    TEST_PLAYER_ID,
    "wheat",
    null,
    store,
    buildPlantDeps({
      shouldUsePostgresRuntime: () => true,
      plantPlayerCrop: async () => 1,
      getPlayer: async () => pgPlayer,
    }),
  );

  assert.equal(v1Result.player.irrigationLevel, 6);
  assert.equal(pgResult.player.irrigationLevel, 6);
  // growMinutes() reel de farm.ts, jamais reimplemente ici : meme
  // irrigationLevel => meme temps de pousse affiche, V1 ou Postgres.
  assert.equal(growMinutes(v1Result.player, "wheat"), growMinutes(pgResult.player, "wheat"));
});

// ===========================================================================
// resolveCraftItem -- meme structure que resolveBuyUpgrade/resolveDailyClaim
// ci-dessus. La plus simple des quatre commandes migrees : aucune seconde
// lecture necessaire (voir le commentaire de resolveCraftItem dans
// presenters.ts).
// ===========================================================================

function buildCraftDeps(overrides: Partial<CraftResolutionDeps> = {}): CraftResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    craftPlayerItem: async () => 1,
    ...overrides,
  };
}

test("resolveCraftItem A. joueur non allowliste : utilise store.mutatePlayer, jamais ensurePlayerExists/craftPlayerItem, meme regle V1 (craft reel de farm.ts)", async () => {
  const player = buildPlayerState({ inventory: { wheat: 10 } });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
  const craftPlayerItem = mock.fn(async () => 99);
  const deps = buildCraftDeps({ shouldUsePostgresRuntime: () => false, ensurePlayerExists, craftPlayerItem });

  const crafted = await resolveCraftItem(TEST_PLAYER_ID, "bread", 3, store, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(craftPlayerItem.mock.calls.length, 0);
  // craft() reel de farm.ts : "bread" necessite 3 ble/unite -- 3 pains =>
  // 9 ble consommes (10 disponibles), 3 pains crees -- regle V1 inchangee.
  assert.equal(crafted, 3);
  assert.equal(player.inventory.wheat, 1);
  assert.equal(player.inventory.bread, 3);
});

test("resolveCraftItem B. joueur allowliste existant : ensurePlayerExists + craftPlayerItem avec le bon playerId/recipeId/quantite, jamais store.mutatePlayer", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer ne doit jamais etre appele sur le chemin Postgres");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const craftPlayerItem = mock.fn(async () => 5);
  const deps = buildCraftDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, craftPlayerItem });

  const crafted = await resolveCraftItem(TEST_PLAYER_ID, "bread", 5, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(craftPlayerItem.mock.calls.length, 1);
  assert.deepEqual(craftPlayerItem.mock.calls[0]!.arguments, [TEST_PLAYER_ID, "bread", 5]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
  assert.equal(crafted, 5);
});

test("resolveCraftItem C. joueur allowliste absent : bootstrap (created=true) PUIS craftPlayerItem, aucun chemin JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const craftPlayerItem = mock.fn(async () => {
    callOrder.push("craft");
    return 1;
  });
  const deps = buildCraftDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, craftPlayerItem });

  await resolveCraftItem(TEST_PLAYER_ID, "bread", 1, store, deps);

  assert.deepEqual(callOrder, ["ensure", "craft"]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
});

test("resolveCraftItem D. erreur metier Postgres : FarmError propagee telle quelle, aucun fallback silencieux vers JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun fallback JSON attendu apres une erreur Postgres");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const craftPlayerItem = mock.fn(async () => {
    throw new FarmError("Tu n'as pas assez de cultures pour cette recette.");
  });
  const deps = buildCraftDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, craftPlayerItem });

  await assert.rejects(
    () => resolveCraftItem(TEST_PLAYER_ID, "bread", 40, store, deps),
    (error: unknown) => error instanceof FarmError,
  );
  assert.equal(mutatePlayer.mock.calls.length, 0, "aucun fallback silencieux vers JSON apres une erreur Postgres");
});

test("resolveCraftItem E. env FARM2WIN_POSTGRES_TEST_PLAYER_IDS absente, avec la VRAIE shouldUsePostgresRuntime (non mockee) : comportement V1 par defaut", async () => {
  const originalEnv = process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
  try {
    delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    const player = buildPlayerState({ inventory: { wheat: 10 } });
    const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
      mutator(player);
      return player;
    });
    const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
    const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
    const craftPlayerItem = mock.fn(async () => 999);

    const crafted = await resolveCraftItem(TEST_PLAYER_ID, "bread", 2, store, {
      shouldUsePostgresRuntime, // la VRAIE fonction importee, pas un mock
      ensurePlayerExists,
      craftPlayerItem,
    });

    assert.equal(mutatePlayer.mock.calls.length, 1);
    assert.equal(ensurePlayerExists.mock.calls.length, 0);
    assert.equal(craftPlayerItem.mock.calls.length, 0);
    assert.equal(crafted, 2);
  } finally {
    if (originalEnv === undefined) delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    else process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR] = originalEnv;
  }
});

test("resolveCraftItem F. reponse : la quantite retournee correspond exactement a la quantite demandee, V1 et Postgres", async () => {
  const player = buildPlayerState({ inventory: { wheat: 100 } });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);

  const v1Crafted = await resolveCraftItem(
    TEST_PLAYER_ID,
    "bread",
    4,
    store,
    buildCraftDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pgCrafted = await resolveCraftItem(
    TEST_PLAYER_ID,
    "bread",
    4,
    store,
    buildCraftDeps({ shouldUsePostgresRuntime: () => true, craftPlayerItem: async () => 4 }),
  );

  assert.equal(v1Crafted, 4);
  assert.equal(pgCrafted, 4);
});

// ===========================================================================
// resolveHarvestCrops -- meme structure que les precedents, avec la meme
// nuance que resolvePlantCrop : la reponse Discord a besoin d'une DEUXIEME
// donnee (le GlobalState reellement utilise pour le rendement/la meteo),
// en plus du HarvestResult lui-meme. Contrairement aux 4 autres, harvest()
// mute AUSSI le global (daily_challenge) -- verifie a l'audit /harvest.
// ===========================================================================

function buildHarvestDeps(overrides: Partial<HarvestResolutionDeps> = {}): HarvestResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    harvestPlayerCrops: async () => ({
      result: { harvested: [], totalXp: 0, leveledUpTo: 1 },
      global: buildGlobalState(),
    }),
    ...overrides,
  };
}

test("resolveHarvestCrops A. joueur non allowliste : utilise store.mutatePlayer, jamais ensurePlayerExists/harvestPlayerCrops, meme regle V1 (harvest reel de farm.ts)", async () => {
  const player = buildPlayerState({
    plots: [{ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false }],
  });
  const global = buildGlobalState();
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], global);
  const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
  const harvestPlayerCrops = mock.fn(async () => {
    throw new Error("harvestPlayerCrops ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildHarvestDeps({ shouldUsePostgresRuntime: () => false, ensurePlayerExists, harvestPlayerCrops });

  const { result, global: returnedGlobal } = await resolveHarvestCrops(TEST_PLAYER_ID, store, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(harvestPlayerCrops.mock.calls.length, 0);
  // harvest() reel de farm.ts : parcelle pretes (10 min > 5 min de pousse
  // du ble) -- regle V1 inchangee.
  assert.equal(result.harvested.length, 1);
  assert.equal(returnedGlobal, global, "le GlobalState retourne doit etre store.global, celui reellement mute par harvest()");
});

test("resolveHarvestCrops B. joueur allowliste existant : ensurePlayerExists + harvestPlayerCrops avec le bon playerId, jamais store.mutatePlayer", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer ne doit jamais etre appele sur le chemin Postgres");
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], buildGlobalState());
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const pgGlobal = buildGlobalState({ weather: "rain", weatherMultiplier: 1.25 });
  const harvestPlayerCrops = mock.fn(async () => ({
    result: { harvested: [{ cropId: "wheat" as const, amount: 5, xp: 2, replanted: false }], totalXp: 2, leveledUpTo: 1 },
    global: pgGlobal,
  }));
  const deps = buildHarvestDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, harvestPlayerCrops });

  const { result, global } = await resolveHarvestCrops(TEST_PLAYER_ID, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(harvestPlayerCrops.mock.calls.length, 1);
  assert.deepEqual(harvestPlayerCrops.mock.calls[0]!.arguments, [TEST_PLAYER_ID]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
  assert.equal(result.harvested.length, 1);
  assert.equal(global, pgGlobal, "le GlobalState retourne doit etre celui de Postgres, jamais store.global (JSON)");
});

test("resolveHarvestCrops C. joueur allowliste absent : bootstrap (created=true) PUIS harvestPlayerCrops, aucun chemin JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], buildGlobalState());
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const harvestPlayerCrops = mock.fn(async () => {
    callOrder.push("harvest");
    return { result: { harvested: [], totalXp: 0, leveledUpTo: 1 }, global: buildGlobalState() };
  });
  const deps = buildHarvestDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, harvestPlayerCrops });

  await resolveHarvestCrops(TEST_PLAYER_ID, store, deps);

  assert.deepEqual(callOrder, ["ensure", "harvest"]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
});

test("resolveHarvestCrops D. aucune parcelle prete : harvested vide, AUCUNE erreur levee ici (le controle vit dans commandHarvest, comme en V1), pour les DEUX branches", async () => {
  const emptyPlayer = buildPlayerState({ plots: [{ cropId: null, plantedAt: null, notifiedReady: false }] });
  const global = buildGlobalState();
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(emptyPlayer);
    return emptyPlayer;
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], global);

  const v1Result = await resolveHarvestCrops(TEST_PLAYER_ID, store, buildHarvestDeps({ shouldUsePostgresRuntime: () => false }));
  const pgResult = await resolveHarvestCrops(
    TEST_PLAYER_ID,
    store,
    buildHarvestDeps({
      shouldUsePostgresRuntime: () => true,
      harvestPlayerCrops: async () => ({ result: { harvested: [], totalXp: 0, leveledUpTo: 1 }, global }),
    }),
  );

  assert.deepEqual(v1Result.result.harvested, []);
  assert.deepEqual(pgResult.result.harvested, []);
});

test("resolveHarvestCrops E. env FARM2WIN_POSTGRES_TEST_PLAYER_IDS absente, avec la VRAIE shouldUsePostgresRuntime (non mockee) : comportement V1 par defaut", async () => {
  const originalEnv = process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
  try {
    delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    const player = buildPlayerState({
      plots: [{ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false }],
    });
    const global = buildGlobalState();
    const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
      mutator(player);
      return player;
    });
    const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], global);
    const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
    const harvestPlayerCrops = mock.fn(async () => {
      throw new Error("harvestPlayerCrops ne doit jamais etre appele en V1");
    });

    const { result } = await resolveHarvestCrops(TEST_PLAYER_ID, store, {
      shouldUsePostgresRuntime, // la VRAIE fonction importee, pas un mock
      ensurePlayerExists,
      harvestPlayerCrops,
    });

    assert.equal(mutatePlayer.mock.calls.length, 1);
    assert.equal(ensurePlayerExists.mock.calls.length, 0);
    assert.equal(harvestPlayerCrops.mock.calls.length, 0);
    assert.equal(result.harvested.length, 1);
  } finally {
    if (originalEnv === undefined) delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    else process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR] = originalEnv;
  }
});

test("resolveHarvestCrops F. reponse : la meteo affichee (weatherLineForGlobal) provient TOUJOURS du meme GlobalState que celui utilise pour le rendement, jamais d'un autre", async () => {
  const player = buildPlayerState({
    plots: [{ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false }],
  });
  // store.global (JSON) et le global Postgres ont des meteos DIFFERENTES
  // deliberement, pour prouver qu'on ne peut jamais confondre les deux.
  const jsonGlobal = buildGlobalState({ weather: "normal", weatherMultiplier: 1 });
  const pgGlobal = buildGlobalState({ weather: "pests", weatherMultiplier: 0.75 });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], jsonGlobal);

  const v1 = await resolveHarvestCrops(TEST_PLAYER_ID, store, buildHarvestDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveHarvestCrops(
    TEST_PLAYER_ID,
    store,
    buildHarvestDeps({
      shouldUsePostgresRuntime: () => true,
      harvestPlayerCrops: async () => ({
        result: { harvested: [{ cropId: "wheat", amount: 3, xp: 2, replanted: false }], totalXp: 2, leveledUpTo: 1 },
        global: pgGlobal,
      }),
    }),
  );

  assert.equal(v1.global, jsonGlobal);
  assert.equal(pg.global, pgGlobal);
  assert.notEqual(v1.global.weather, pg.global.weather, "les deux meteos sont volontairement differentes dans ce test");
});

// ===========================================================================
// resolveSellItems -- meme structure que resolveHarvestCrops (meme
// primitive mutatePlayerAndGlobal(), meme nuance : la reponse Discord a
// besoin du GlobalState reellement utilise pour "Contrat restant").
// ===========================================================================

function buildSellDeps(overrides: Partial<SellResolutionDeps> = {}): SellResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    sellPlayerItems: async () => ({
      result: { sold: [], earned: 0 },
      global: buildGlobalState(),
    }),
    ...overrides,
  };
}

test("resolveSellItems A. joueur non allowliste : utilise store.mutatePlayer, jamais ensurePlayerExists/sellPlayerItems, meme regle V1 (sell reel de farm.ts, inventaire diminue, coins augmentes)", async () => {
  const player = buildPlayerState({ inventory: { wheat: 10 }, coins: 0 });
  const global = buildGlobalState();
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], global);
  const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
  const sellPlayerItems = mock.fn(async () => {
    throw new Error("sellPlayerItems ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildSellDeps({ shouldUsePostgresRuntime: () => false, ensurePlayerExists, sellPlayerItems });

  const { result, global: returnedGlobal } = await resolveSellItems(TEST_PLAYER_ID, "wheat", 5, store, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(sellPlayerItems.mock.calls.length, 0);
  // sell("wheat", 5) reel de farm.ts : marketMultiplier=1 => currentCropPrice(wheat)=4
  // (basePrice), aucun bonus de contrat (contract.cropId="wheat" mais
  // remaining=20 -- ICI le contrat EST rempli, voir test E dedie pour le
  // bonus). Ce test-ci verifie surtout inventaire/coins, pas le contrat.
  assert.equal(player.inventory.wheat, 5);
  assert.ok(player.coins > 0, "les coins doivent avoir augmente");
  assert.equal(returnedGlobal, global, "le GlobalState retourne doit etre store.global, celui reellement mute par sell()");
});

test("resolveSellItems B. joueur allowliste existant : ensurePlayerExists + sellPlayerItems avec le bon playerId/itemId/quantite, jamais store.mutatePlayer", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer ne doit jamais etre appele sur le chemin Postgres");
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], buildGlobalState());
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const pgGlobal = buildGlobalState({ contract: { cropId: "wheat", required: 20, remaining: 15, bonusMultiplier: 1.6, renewedAt: NOW } });
  const sellPlayerItems = mock.fn(async () => ({
    result: { sold: [{ itemId: "wheat" as const, amount: 5, earned: 20 }], earned: 20 },
    global: pgGlobal,
  }));
  const deps = buildSellDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, sellPlayerItems });

  const { result, global } = await resolveSellItems(TEST_PLAYER_ID, "wheat", 5, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(sellPlayerItems.mock.calls.length, 1);
  assert.deepEqual(sellPlayerItems.mock.calls[0]!.arguments, [TEST_PLAYER_ID, "wheat", 5]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
  assert.equal(result.earned, 20);
  assert.equal(global, pgGlobal, "le GlobalState retourne doit etre celui de Postgres, jamais store.global (JSON)");
});

test("resolveSellItems C. contrat : le bonus exact V1 est applique et contract.remaining mis a jour exactement comme V1 (sell reel de farm.ts)", async () => {
  const player = buildPlayerState({ inventory: { wheat: 10 }, coins: 0 });
  // contract.cropId="wheat", remaining=6 : vente de 10 -> 6 contractees (bonus),
  // 4 au prix normal -- regle V1 exacte de sell().
  const global = buildGlobalState({
    marketMultiplier: 1,
    contract: { cropId: "wheat", required: 20, remaining: 6, bonusMultiplier: 1.6, renewedAt: NOW },
  });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], global);

  const { result, global: returnedGlobal } = await resolveSellItems(
    TEST_PLAYER_ID,
    "wheat",
    10,
    store,
    buildSellDeps({ shouldUsePostgresRuntime: () => false }),
  );

  // basePrice(wheat)=4, marketMultiplier=1 => normalPrice=4.
  // bonus par unite = round(4*1.6) = 6. 6 unites contractees * 6 + 4 unites * 4 = 36+16 = 52.
  assert.equal(result.earned, 52);
  assert.equal(returnedGlobal.contract.remaining, 0, "contract.remaining doit etre exactement 0 (6-6), jamais negatif");
  assert.equal(player.inventory.wheat, 0);
});

test("resolveSellItems D. marche : le prix reflete exactement currentCropPrice()/productPrice() de farm.ts, aucune formule reimplementee dans presenters.ts", async () => {
  const player = buildPlayerState({ inventory: { wheat: 5 }, coins: 0 });
  // marketMultiplier=2 : normalPrice = round(4*2) = 8. Aucun contrat pour
  // ce test (cropId different) -- prix 100% marche.
  const global = buildGlobalState({
    marketMultiplier: 2,
    contract: { cropId: "carrot", required: 20, remaining: 20, bonusMultiplier: 1.6, renewedAt: NOW },
  });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], global);

  const { result } = await resolveSellItems(
    TEST_PLAYER_ID,
    "wheat",
    5,
    store,
    buildSellDeps({ shouldUsePostgresRuntime: () => false }),
  );

  assert.equal(result.earned, 40); // 5 * round(4*2) = 40
});

test("resolveSellItems E. joueur allowliste absent : bootstrap (created=true) PUIS sellPlayerItems, aucun chemin JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], buildGlobalState());
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const sellPlayerItems = mock.fn(async () => {
    callOrder.push("sell");
    return { result: { sold: [], earned: 0 }, global: buildGlobalState() };
  });
  const deps = buildSellDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, sellPlayerItems });

  await resolveSellItems(TEST_PLAYER_ID, "all", null, store, deps);

  assert.deepEqual(callOrder, ["ensure", "sell"]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
});

test("resolveSellItems F. erreur metier (aucune ressource a vendre) : FarmError propagee telle quelle, aucun fallback silencieux vers JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun fallback JSON attendu apres une erreur Postgres");
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], buildGlobalState());
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const sellPlayerItems = mock.fn(async () => {
    throw new FarmError("Tu n'as aucune ressource de ce type à vendre.");
  });
  const deps = buildSellDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, sellPlayerItems });

  await assert.rejects(
    () => resolveSellItems(TEST_PLAYER_ID, "wheat", null, store, deps),
    (error: unknown) => error instanceof FarmError,
  );
  assert.equal(mutatePlayer.mock.calls.length, 0, "aucun fallback silencieux vers JSON apres une erreur Postgres");
});

test("resolveSellItems G. env FARM2WIN_POSTGRES_TEST_PLAYER_IDS absente, avec la VRAIE shouldUsePostgresRuntime (non mockee) : comportement V1 par defaut", async () => {
  const originalEnv = process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
  try {
    delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    const player = buildPlayerState({ inventory: { wheat: 10 }, coins: 0 });
    const global = buildGlobalState();
    const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
      mutator(player);
      return player;
    });
    const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], global);
    const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
    const sellPlayerItems = mock.fn(async () => {
      throw new Error("sellPlayerItems ne doit jamais etre appele en V1");
    });

    const { result } = await resolveSellItems(TEST_PLAYER_ID, "wheat", 3, store, {
      shouldUsePostgresRuntime, // la VRAIE fonction importee, pas un mock
      ensurePlayerExists,
      sellPlayerItems,
    });

    assert.equal(mutatePlayer.mock.calls.length, 1);
    assert.equal(ensurePlayerExists.mock.calls.length, 0);
    assert.equal(sellPlayerItems.mock.calls.length, 0);
    assert.equal(result.sold.length, 1);
  } finally {
    if (originalEnv === undefined) delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    else process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR] = originalEnv;
  }
});

test("resolveSellItems H. reponse : le GlobalState retourne (donc 'Contrat restant' affiche) provient TOUJOURS de celui reellement utilise par la vente, jamais de store.global", async () => {
  const player = buildPlayerState({ inventory: { wheat: 10 }, coins: 0 });
  // store.global (JSON) et le global Postgres ont des contract.remaining
  // DIFFERENTS deliberement, pour prouver qu'on ne peut jamais confondre
  // les deux (meme principe que resolveHarvestCrops F. pour la meteo).
  const jsonGlobal = buildGlobalState({ contract: { cropId: "wheat", required: 20, remaining: 20, bonusMultiplier: 1.6, renewedAt: NOW } });
  const pgGlobal = buildGlobalState({ contract: { cropId: "wheat", required: 20, remaining: 3, bonusMultiplier: 1.6, renewedAt: NOW } });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStoreForHarvest(mutatePlayer as unknown as FarmStore["mutatePlayer"], jsonGlobal);

  const v1 = await resolveSellItems(TEST_PLAYER_ID, "wheat", 5, store, buildSellDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveSellItems(
    TEST_PLAYER_ID,
    "wheat",
    5,
    store,
    buildSellDeps({
      shouldUsePostgresRuntime: () => true,
      sellPlayerItems: async () => ({
        result: { sold: [{ itemId: "wheat", amount: 5, earned: 20 }], earned: 20 },
        global: pgGlobal,
      }),
    }),
  );

  assert.equal(v1.global, jsonGlobal);
  assert.equal(pg.global, pgGlobal);
  assert.notEqual(
    v1.global.contract.remaining,
    pg.global.contract.remaining,
    "les deux contract.remaining sont volontairement differents dans ce test",
  );
});

// ===========================================================================
// resolveInventory -- contrairement a tous les resolveXxx precedents,
// /inventory est PUREMENT LECTURE SEULE : aucune fonction mutante de
// farm.ts n'est appelee, donc aucun test ici ne mocke mutatePlayer ni
// mutatePlayerAndGlobal. Seules deux lectures existantes sont impliquees
// cote Postgres : getPlayer() et getGlobalState() (toutes deux deja
// testees independamment dans farmRepository.test.ts). Les tests D-G
// verifient que les DONNEES retournees par resolveInventory (pas la
// construction de l'embed, qui reste dans commandInventory, inchangee)
// alimentent les memes formules que V1 (currentCropPrice/productPrice/
// totalInventoryValue de farm.ts, aucune reimplementation dans
// presenters.ts), pour un inventaire vide, une culture et un produit
// transforme.
// ===========================================================================

function buildInventoryDeps(overrides: Partial<InventoryResolutionDeps> = {}): InventoryResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    getPlayer: async (playerId: string) => buildPlayerState({ userId: playerId }),
    getGlobalState: async () => buildGlobalState(),
    ...overrides,
  };
}

test("resolveInventory A. joueur non allowliste : utilise store.getPlayer()/store.global, jamais ensurePlayerExists/deps.getPlayer/deps.getGlobalState, meme chemin V1", async () => {
  const player = buildPlayerState({ inventory: { wheat: 3 } });
  const global = buildGlobalState();
  const getPlayer = mock.fn((_playerId: string) => player);
  const store = buildFakeStoreForInventory(getPlayer as unknown as FarmStore["getPlayer"], global);
  const ensurePlayerExists = mock.fn(async () => {
    throw new Error("ensurePlayerExists ne doit jamais etre appele sur le chemin V1");
  });
  const pgGetPlayer = mock.fn(async () => {
    throw new Error("le repository getPlayer ne doit jamais etre appele sur le chemin V1");
  });
  const getGlobalState = mock.fn(async () => {
    throw new Error("getGlobalState ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildInventoryDeps({
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists,
    getPlayer: pgGetPlayer,
    getGlobalState,
  });

  const result = await resolveInventory(TEST_PLAYER_ID, store, deps);

  assert.equal(getPlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(pgGetPlayer.mock.calls.length, 0);
  assert.equal(getGlobalState.mock.calls.length, 0);
  assert.equal(result.player, player, "doit retourner exactement le PlayerState de store.getPlayer()");
  assert.equal(result.global, global, "doit retourner exactement store.global");
});

test("resolveInventory B. joueur allowliste existant : ensurePlayerExists + deps.getPlayer + deps.getGlobalState avec le bon playerId, jamais store.getPlayer", async () => {
  const store = buildFakeStoreForInventory(
    mock.fn(() => {
      throw new Error("store.getPlayer ne doit jamais etre appele sur le chemin Postgres");
    }) as unknown as FarmStore["getPlayer"],
    buildGlobalState(),
  );
  const pgPlayer = buildPlayerState({ userId: TEST_PLAYER_ID, inventory: { bread: 2 } });
  const pgGlobal = buildGlobalState({ marketMultiplier: 1.4 });
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const getPlayer = mock.fn(async (_playerId: string) => pgPlayer);
  const getGlobalState = mock.fn(async () => pgGlobal);
  const deps = buildInventoryDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, getPlayer, getGlobalState });

  const result = await resolveInventory(TEST_PLAYER_ID, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(getPlayer.mock.calls.length, 1);
  assert.equal(getPlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(getGlobalState.mock.calls.length, 1);
  assert.equal(result.player, pgPlayer, "doit retourner exactement le PlayerState du repository Postgres");
  assert.equal(result.global, pgGlobal, "doit retourner exactement le GlobalState du repository Postgres, jamais store.global");
});

test("resolveInventory C. joueur allowliste absent : bootstrap (created=true) PUIS lecture Postgres, aucun chemin JSON", async () => {
  const store = buildFakeStoreForInventory(
    mock.fn(() => {
      throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
    }) as unknown as FarmStore["getPlayer"],
    buildGlobalState(),
  );
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const getPlayer = mock.fn(async () => {
    callOrder.push("getPlayer");
    return buildPlayerState({ userId: TEST_PLAYER_ID });
  });
  const getGlobalState = mock.fn(async () => {
    callOrder.push("getGlobalState");
    return buildGlobalState();
  });
  const deps = buildInventoryDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, getPlayer, getGlobalState });

  await resolveInventory(TEST_PLAYER_ID, store, deps);

  assert.deepEqual(callOrder, ["ensure", "getPlayer", "getGlobalState"]);
});

test("resolveInventory D. inventaire vide (aucune ligne Postgres) : equivalent a un inventaire JSON explicitement a 0, meme valeur totale, aucun bug", async () => {
  const jsonPlayer = buildPlayerState({ inventory: { wheat: 0, carrot: 0, bread: 0 } });
  const pgPlayer = buildPlayerState({ inventory: {} });
  const global = buildGlobalState();

  const v1 = await resolveInventory(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => jsonPlayer) as unknown as FarmStore["getPlayer"], global),
    buildInventoryDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveInventory(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => jsonPlayer) as unknown as FarmStore["getPlayer"], global),
    buildInventoryDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer, getGlobalState: async () => global }),
  );

  assert.equal(totalInventoryValue(v1.player, v1.global), 0);
  assert.equal(totalInventoryValue(pg.player, pg.global), 0);
  assert.equal(
    totalInventoryValue(v1.player, v1.global),
    totalInventoryValue(pg.player, pg.global),
    "meme valeur totale, que l'inventaire JSON ait des cles a 0 ou que Postgres n'ait aucune ligne",
  );
});

test("resolveInventory E. inventaire avec une culture : la quantite et le prix reels (currentCropPrice de farm.ts) sont identiques V1/Postgres, aucune formule reimplementee", async () => {
  const pgPlayer = buildPlayerState({ inventory: { wheat: 7 } });
  const pgGlobal = buildGlobalState({ marketMultiplier: 1.3 });

  const pg = await resolveInventory(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildInventoryDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer, getGlobalState: async () => pgGlobal }),
  );

  const amount = pg.player.inventory.wheat ?? 0;
  assert.equal(amount, 7);
  const value = amount * currentCropPrice(pg.global, "wheat");
  assert.equal(value, 7 * currentCropPrice(pgGlobal, "wheat"), "doit utiliser le GlobalState Postgres retourne, jamais store.global");
});

test("resolveInventory F. inventaire avec un produit transforme : la quantite et le prix reels (productPrice de farm.ts) sont identiques V1/Postgres, aucune formule reimplementee", async () => {
  const pgPlayer = buildPlayerState({ inventory: { bread: 3 } });

  const pg = await resolveInventory(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildInventoryDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer }),
  );

  const amount = pg.player.inventory.bread ?? 0;
  assert.equal(amount, 3);
  assert.equal(amount * productPrice("bread"), 3 * productPrice("bread"), "un produit transforme n'a pas de dependance au marche, contrairement a une culture");
});

test("resolveInventory G. valeur totale (totalInventoryValue de farm.ts) : calculee a partir du GlobalState reellement retourne par resolveInventory, jamais de store.global", async () => {
  const jsonGlobal = buildGlobalState({ marketMultiplier: 1 });
  const pgGlobal = buildGlobalState({ marketMultiplier: 2 });
  const pgPlayer = buildPlayerState({ inventory: { wheat: 10 } });

  const v1 = await resolveInventory(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState({ inventory: { wheat: 10 } })) as unknown as FarmStore["getPlayer"], jsonGlobal),
    buildInventoryDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveInventory(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], jsonGlobal),
    buildInventoryDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer, getGlobalState: async () => pgGlobal }),
  );

  assert.equal(v1.global, jsonGlobal);
  assert.equal(pg.global, pgGlobal);
  assert.notEqual(
    totalInventoryValue(v1.player, v1.global),
    totalInventoryValue(pg.player, pg.global),
    "meme quantite (10 ble), mais marketMultiplier volontairement different (1 vs 2) : la valeur DOIT differer, preuve que pg.global est bien utilise, jamais jsonGlobal cote Postgres",
  );
});

// ===========================================================================
// resolveFarmView -- meme categorie que resolveInventory (LECTURE SEULE,
// aucun mock de mutatePlayer/mutatePlayerAndGlobal). Contrairement a
// /inventory, le temps restant/statut pret (growMinutes()/isReady()/
// growthPercent() de farm.ts) ne depend QUE du PlayerState (plots,
// irrigationLevel) -- jamais du GlobalState (verifie a l'audit) ; seule la
// ligne meteo affichee depend du GlobalState. Les tests D-H verifient que
// les DONNEES retournees par resolveFarmView (pas la construction de
// l'embed, qui reste dans commandFarm, inchangee) alimentent les memes
// formules que V1, pour des parcelles vides, une culture en croissance,
// une culture prete, un niveau d'irrigation et la meteo.
// ===========================================================================

function buildFarmViewDeps(overrides: Partial<FarmViewResolutionDeps> = {}): FarmViewResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    getPlayer: async (playerId: string) => buildPlayerState({ userId: playerId }),
    getGlobalState: async () => buildGlobalState(),
    ...overrides,
  };
}

test("resolveFarmView A. joueur non allowliste : utilise store.getPlayer()/store.global, jamais ensurePlayerExists/deps.getPlayer/deps.getGlobalState, meme chemin V1", async () => {
  const player = buildPlayerState({ plots: [{ cropId: "wheat", plantedAt: NOW, notifiedReady: false }] });
  const global = buildGlobalState();
  const getPlayer = mock.fn((_playerId: string) => player);
  const store = buildFakeStoreForInventory(getPlayer as unknown as FarmStore["getPlayer"], global);
  const ensurePlayerExists = mock.fn(async () => {
    throw new Error("ensurePlayerExists ne doit jamais etre appele sur le chemin V1");
  });
  const pgGetPlayer = mock.fn(async () => {
    throw new Error("le repository getPlayer ne doit jamais etre appele sur le chemin V1");
  });
  const getGlobalState = mock.fn(async () => {
    throw new Error("getGlobalState ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildFarmViewDeps({
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists,
    getPlayer: pgGetPlayer,
    getGlobalState,
  });

  const result = await resolveFarmView(TEST_PLAYER_ID, store, deps);

  assert.equal(getPlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(pgGetPlayer.mock.calls.length, 0);
  assert.equal(getGlobalState.mock.calls.length, 0);
  assert.equal(result.player, player, "doit retourner exactement le PlayerState de store.getPlayer()");
  assert.equal(result.global, global, "doit retourner exactement store.global");
});

test("resolveFarmView B. joueur allowliste existant : ensurePlayerExists + deps.getPlayer + deps.getGlobalState avec le bon playerId, jamais store.getPlayer", async () => {
  const store = buildFakeStoreForInventory(
    mock.fn(() => {
      throw new Error("store.getPlayer ne doit jamais etre appele sur le chemin Postgres");
    }) as unknown as FarmStore["getPlayer"],
    buildGlobalState(),
  );
  const pgPlayer = buildPlayerState({ userId: TEST_PLAYER_ID, plots: [{ cropId: "wheat", plantedAt: NOW, notifiedReady: false }] });
  const pgGlobal = buildGlobalState({ weather: "rain" });
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const getPlayer = mock.fn(async (_playerId: string) => pgPlayer);
  const getGlobalState = mock.fn(async () => pgGlobal);
  const deps = buildFarmViewDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, getPlayer, getGlobalState });

  const result = await resolveFarmView(TEST_PLAYER_ID, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(getPlayer.mock.calls.length, 1);
  assert.equal(getPlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(getGlobalState.mock.calls.length, 1);
  assert.equal(result.player, pgPlayer, "doit retourner exactement le PlayerState du repository Postgres");
  assert.equal(result.global, pgGlobal, "doit retourner exactement le GlobalState du repository Postgres, jamais store.global");
});

test("resolveFarmView C. joueur allowliste absent : bootstrap (created=true) PUIS lecture Postgres, aucun chemin JSON", async () => {
  const store = buildFakeStoreForInventory(
    mock.fn(() => {
      throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
    }) as unknown as FarmStore["getPlayer"],
    buildGlobalState(),
  );
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const getPlayer = mock.fn(async () => {
    callOrder.push("getPlayer");
    return buildPlayerState({ userId: TEST_PLAYER_ID });
  });
  const getGlobalState = mock.fn(async () => {
    callOrder.push("getGlobalState");
    return buildGlobalState();
  });
  const deps = buildFarmViewDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, getPlayer, getGlobalState });

  await resolveFarmView(TEST_PLAYER_ID, store, deps);

  assert.deepEqual(callOrder, ["ensure", "getPlayer", "getGlobalState"]);
});

test("resolveFarmView D. parcelles vides : le PlayerState retourne produit le meme rendu (aucune culture, 0%, jamais pret), V1 et Postgres", async () => {
  const emptyPlots = [{ cropId: null, plantedAt: null, notifiedReady: false }];
  const jsonPlayer = buildPlayerState({ plots: emptyPlots });
  const pgPlayer = buildPlayerState({ plots: emptyPlots });
  const global = buildGlobalState();

  const v1 = await resolveFarmView(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => jsonPlayer) as unknown as FarmStore["getPlayer"], global),
    buildFarmViewDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveFarmView(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => jsonPlayer) as unknown as FarmStore["getPlayer"], global),
    buildFarmViewDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer, getGlobalState: async () => global }),
  );

  assert.equal(isReady(v1.player, 0, NOW), false);
  assert.equal(isReady(pg.player, 0, NOW), false);
  assert.equal(growthPercent(v1.player, 0, NOW), 0);
  assert.equal(growthPercent(pg.player, 0, NOW), 0);
});

test("resolveFarmView E. culture en croissance : growthPercent/isReady (farm.ts) identiques V1/Postgres pour la meme plantation, aucune formule reimplementee", async () => {
  const growingPlots = [{ cropId: "wheat" as const, plantedAt: NOW - 2 * 60 * 1000, notifiedReady: false }];
  const pgPlayer = buildPlayerState({ plots: growingPlots });

  const pg = await resolveFarmView(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildFarmViewDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer }),
  );

  // ble : growMinutes = 5min, 2min ecoulees -> ni pret, ni 0%, ni 100%.
  assert.equal(isReady(pg.player, 0, NOW), false);
  assert.equal(growthPercent(pg.player, 0, NOW), growthPercent(buildPlayerState({ plots: growingPlots }), 0, NOW));
  assert.ok(growthPercent(pg.player, 0, NOW) > 0 && growthPercent(pg.player, 0, NOW) < 100);
});

test("resolveFarmView F. culture prete : isReady (farm.ts) identique V1/Postgres pour la meme plantation, aucune formule reimplementee", async () => {
  const readyPlots = [{ cropId: "wheat" as const, plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false }];
  const pgPlayer = buildPlayerState({ plots: readyPlots });

  const pg = await resolveFarmView(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildFarmViewDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer }),
  );

  assert.equal(isReady(pg.player, 0, NOW), true);
  assert.equal(isReady(buildPlayerState({ plots: readyPlots }), 0, NOW), true);
});

test("resolveFarmView G. irrigation : growMinutes (farm.ts) identique V1/Postgres pour le meme irrigationLevel, aucune formule reimplementee", async () => {
  const pgPlayer = buildPlayerState({ irrigationLevel: 5 });

  const pg = await resolveFarmView(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildFarmViewDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer }),
  );

  assert.equal(pg.player.irrigationLevel, 5);
  assert.equal(growMinutes(pg.player, "wheat"), growMinutes(buildPlayerState({ irrigationLevel: 5 }), "wheat"));
});

test("resolveFarmView H. meteo : la ligne affichee (weatherLineForGlobal, via WEATHER_INFO) provient TOUJOURS du GlobalState reellement retourne par resolveFarmView, jamais de store.global", async () => {
  const jsonGlobal = buildGlobalState({ weather: "normal" });
  const pgGlobal = buildGlobalState({ weather: "rain" });

  const v1 = await resolveFarmView(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], jsonGlobal),
    buildFarmViewDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveFarmView(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], jsonGlobal),
    buildFarmViewDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => buildPlayerState(), getGlobalState: async () => pgGlobal }),
  );

  assert.equal(v1.global, jsonGlobal);
  assert.equal(pg.global, pgGlobal);
  assert.notEqual(
    v1.global.weather,
    pg.global.weather,
    "les deux meteos sont volontairement differentes dans ce test, preuve que pg.global est bien utilise, jamais jsonGlobal cote Postgres",
  );
});

// ===========================================================================
// resolveProfile -- meme categorie que resolveInventory/resolveFarmView
// (LECTURE SEULE, aucun mock de mutatePlayer/mutatePlayerAndGlobal).
// commandProfile (V1 reel, verifie a l'audit) N'AFFICHE NI achievements, NI
// skins/unlockedSkins, NI quests, NI totalHarvested, NI weeklySnapshotCoins
// -- seulement level/xp/coins/plots.length/irrigationLevel/fertilizerLevel/
// autoReplant (PLAYER-ONLY) et totalInventoryValue(player, global), qui
// depend du GlobalState. Le test H ci-dessous prouve par lecture du source
// que commandProfile ne lit toujours aucun de ces champs non affiches en
// V1 (garde-fou anti-scope-creep : aucune fonctionnalite non presente en
// V1 ne doit apparaitre a l'occasion de ce branchement).
// ===========================================================================

function buildProfileDeps(overrides: Partial<ProfileResolutionDeps> = {}): ProfileResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    getPlayer: async (playerId: string) => buildPlayerState({ userId: playerId }),
    getGlobalState: async () => buildGlobalState(),
    ...overrides,
  };
}

test("resolveProfile A. joueur non allowliste : utilise store.getPlayer()/store.global, jamais ensurePlayerExists/deps.getPlayer/deps.getGlobalState, meme chemin V1", async () => {
  const player = buildPlayerState({ coins: 250, level: 3, xp: 40 });
  const global = buildGlobalState();
  const getPlayer = mock.fn((_playerId: string) => player);
  const store = buildFakeStoreForInventory(getPlayer as unknown as FarmStore["getPlayer"], global);
  const ensurePlayerExists = mock.fn(async () => {
    throw new Error("ensurePlayerExists ne doit jamais etre appele sur le chemin V1");
  });
  const pgGetPlayer = mock.fn(async () => {
    throw new Error("le repository getPlayer ne doit jamais etre appele sur le chemin V1");
  });
  const getGlobalState = mock.fn(async () => {
    throw new Error("getGlobalState ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildProfileDeps({
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists,
    getPlayer: pgGetPlayer,
    getGlobalState,
  });

  const result = await resolveProfile(TEST_PLAYER_ID, store, deps);

  assert.equal(getPlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(pgGetPlayer.mock.calls.length, 0);
  assert.equal(getGlobalState.mock.calls.length, 0);
  assert.equal(result.player, player, "doit retourner exactement le PlayerState de store.getPlayer()");
  assert.equal(result.global, global, "doit retourner exactement store.global");
});

test("resolveProfile B. joueur allowliste existant : ensurePlayerExists + deps.getPlayer + deps.getGlobalState avec le bon playerId, jamais store.getPlayer", async () => {
  const store = buildFakeStoreForInventory(
    mock.fn(() => {
      throw new Error("store.getPlayer ne doit jamais etre appele sur le chemin Postgres");
    }) as unknown as FarmStore["getPlayer"],
    buildGlobalState(),
  );
  const pgPlayer = buildPlayerState({ userId: TEST_PLAYER_ID, coins: 500, level: 5, xp: 12 });
  const pgGlobal = buildGlobalState({ marketMultiplier: 1.4 });
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const getPlayer = mock.fn(async (_playerId: string) => pgPlayer);
  const getGlobalState = mock.fn(async () => pgGlobal);
  const deps = buildProfileDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, getPlayer, getGlobalState });

  const result = await resolveProfile(TEST_PLAYER_ID, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(getPlayer.mock.calls.length, 1);
  assert.equal(getPlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(getGlobalState.mock.calls.length, 1);
  assert.equal(result.player, pgPlayer, "doit retourner exactement le PlayerState du repository Postgres");
  assert.equal(result.global, pgGlobal, "doit retourner exactement le GlobalState du repository Postgres, jamais store.global");
});

test("resolveProfile C. joueur allowliste absent : bootstrap (created=true) PUIS lecture Postgres, aucun chemin JSON", async () => {
  const store = buildFakeStoreForInventory(
    mock.fn(() => {
      throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
    }) as unknown as FarmStore["getPlayer"],
    buildGlobalState(),
  );
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const getPlayer = mock.fn(async () => {
    callOrder.push("getPlayer");
    return buildPlayerState({ userId: TEST_PLAYER_ID });
  });
  const getGlobalState = mock.fn(async () => {
    callOrder.push("getGlobalState");
    return buildGlobalState();
  });
  const deps = buildProfileDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, getPlayer, getGlobalState });

  await resolveProfile(TEST_PLAYER_ID, store, deps);

  assert.deepEqual(callOrder, ["ensure", "getPlayer", "getGlobalState"]);
});

test("resolveProfile D. joueur fraichement bootstrappe : valeurs initiales (level=1, xp=0, irrigation=0, engrais=0, replantation OFF) affichees identiques V1/Postgres", async () => {
  const freshPlayer = buildPlayerState({
    level: 1,
    xp: 0,
    coins: 0,
    plots: [{ cropId: null, plantedAt: null, notifiedReady: false }],
    irrigationLevel: 0,
    fertilizerLevel: 0,
    autoReplant: false,
  });

  const v1 = await resolveProfile(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => freshPlayer) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildProfileDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveProfile(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildProfileDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => freshPlayer }),
  );

  for (const result of [v1, pg]) {
    assert.equal(result.player.level, 1);
    assert.equal(result.player.xp, 0);
    assert.equal(result.player.coins, 0);
    assert.equal(result.player.plots.length, 1);
    assert.equal(result.player.irrigationLevel, 0);
    assert.equal(result.player.fertilizerLevel, 0);
    assert.equal(result.player.autoReplant, false);
  }
});

test("resolveProfile E. joueur avec progression : coins/level/xp/irrigation/engrais et le calcul derive (xpToNextLevel de farm.ts) sont identiques V1/Postgres, aucune formule reimplementee", async () => {
  const pgPlayer = buildPlayerState({ coins: 1234, level: 7, xp: 88, irrigationLevel: 4, fertilizerLevel: 6 });

  const pg = await resolveProfile(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildProfileDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer }),
  );

  assert.equal(pg.player.coins, 1234);
  assert.equal(pg.player.level, 7);
  assert.equal(pg.player.xp, 88);
  assert.equal(pg.player.irrigationLevel, 4);
  assert.equal(pg.player.fertilizerLevel, 6);
  assert.equal(xpToNextLevel(pg.player.level), xpToNextLevel(7), "aucune formule reimplementee, meme fonction farm.ts");
});

test("resolveProfile F. valeur d'inventaire (totalInventoryValue de farm.ts) : calculee a partir du GlobalState reellement retourne par resolveProfile, jamais de store.global", async () => {
  const jsonGlobal = buildGlobalState({ marketMultiplier: 1 });
  const pgGlobal = buildGlobalState({ marketMultiplier: 2 });
  const pgPlayer = buildPlayerState({ inventory: { wheat: 10 } });

  const v1 = await resolveProfile(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState({ inventory: { wheat: 10 } })) as unknown as FarmStore["getPlayer"], jsonGlobal),
    buildProfileDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveProfile(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], jsonGlobal),
    buildProfileDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer, getGlobalState: async () => pgGlobal }),
  );

  assert.equal(v1.global, jsonGlobal);
  assert.equal(pg.global, pgGlobal);
  assert.notEqual(
    totalInventoryValue(v1.player, v1.global),
    totalInventoryValue(pg.player, pg.global),
    "meme quantite (10 ble), mais marketMultiplier volontairement different (1 vs 2) : la valeur DOIT differer, preuve que pg.global est bien utilise, jamais jsonGlobal cote Postgres",
  );
});

test("resolveProfile G. valeurs absentes/0 (nouveau joueur, inventaire vide) : aucun crash, valeur d'inventaire = 0, identique V1/Postgres", async () => {
  const emptyPlayer = buildPlayerState({ inventory: {}, coins: 0, level: 1, xp: 0 });

  const v1 = await resolveProfile(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => emptyPlayer) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildProfileDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveProfile(
    TEST_PLAYER_ID,
    buildFakeStoreForInventory((() => buildPlayerState()) as unknown as FarmStore["getPlayer"], buildGlobalState()),
    buildProfileDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => emptyPlayer }),
  );

  assert.equal(totalInventoryValue(v1.player, v1.global), 0);
  assert.equal(totalInventoryValue(pg.player, pg.global), 0);
});

test("resolveProfile H. commandProfile n'affiche ni achievements, ni skins/unlockedSkins, ni quests, ni totalHarvested, ni weeklySnapshotCoins (V1 reel, verifie a l'audit) -- garde-fou anti-scope-creep pour ce branchement", async () => {
  const source = await readFile(new URL("./presenters.ts", import.meta.url), "utf8");
  const commandProfileStart = source.indexOf("async function commandProfile(");
  const commandProfileEnd = source.indexOf("async function commandLeaderboard(", commandProfileStart);
  assert.ok(commandProfileStart >= 0, "commandProfile doit exister");
  assert.ok(commandProfileEnd > commandProfileStart, "commandLeaderboard doit exister juste apres commandProfile");
  const body = source.slice(commandProfileStart, commandProfileEnd);

  for (const field of ["achievement", "unlockedSkins", "plotSkin", "quests", "totalHarvested", "weeklySnapshotCoins"]) {
    assert.ok(!body.includes(field), `commandProfile ne doit toujours pas afficher ${field} (absent de V1)`);
  }
});

// ===========================================================================
// resolveMarket -- PREMIERE categorie GLOBAL-ONLY : commandMarket (V1 reel,
// verifie a l'audit) ne lit AUCUNE donnee Player (aucun store.getPlayer()
// dans son corps), uniquement store.global (marketMultiplier,
// previousMarketMultiplier, currentCropPrice()). resolveMarket() n'accepte
// donc meme pas ensurePlayerExists/getPlayer dans ses deps (contrairement a
// resolveInventory/resolveFarmView/resolveProfile) -- aucun bootstrap
// joueur ne doit jamais avoir lieu pour /market, allowliste ou non.
// ===========================================================================

function buildFakeStoreForMarket(global: GlobalState): FarmStore {
  return { global } as unknown as FarmStore;
}

function buildMarketDeps(overrides: Partial<MarketResolutionDeps> = {}): MarketResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    getGlobalState: async () => buildGlobalState(),
    ...overrides,
  };
}

test("resolveMarket A. joueur non allowliste : utilise store.global uniquement, jamais deps.getGlobalState, meme chemin V1", async () => {
  const global = buildGlobalState({ marketMultiplier: 1.1 });
  const store = buildFakeStoreForMarket(global);
  const getGlobalState = mock.fn(async () => {
    throw new Error("getGlobalState ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildMarketDeps({ shouldUsePostgresRuntime: () => false, getGlobalState });

  const result = await resolveMarket(TEST_PLAYER_ID, store, deps);

  assert.equal(getGlobalState.mock.calls.length, 0);
  assert.equal(result, global, "doit retourner exactement store.global");
});

test("resolveMarket B. joueur allowliste : utilise deps.getGlobalState (Postgres) uniquement, jamais store.global, aucune mutation JSON", async () => {
  const jsonGlobal = buildGlobalState({ marketMultiplier: 1 });
  const store = buildFakeStoreForMarket(jsonGlobal);
  const pgGlobal = buildGlobalState({ marketMultiplier: 1.7 });
  const getGlobalState = mock.fn(async () => pgGlobal);
  const deps = buildMarketDeps({ shouldUsePostgresRuntime: () => true, getGlobalState });

  const result = await resolveMarket(TEST_PLAYER_ID, store, deps);

  assert.equal(getGlobalState.mock.calls.length, 1);
  assert.equal(result, pgGlobal, "doit retourner exactement le GlobalState Postgres, jamais store.global");
});

test("resolveMarket C. marketMultiplier : le prix affiche (currentCropPrice de farm.ts) est identique V1/Postgres pour la meme valeur, aucune formule reimplementee", async () => {
  const pgGlobal = buildGlobalState({ marketMultiplier: 1.5 });
  const deps = buildMarketDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => pgGlobal });

  const result = await resolveMarket(TEST_PLAYER_ID, buildFakeStoreForMarket(buildGlobalState()), deps);

  assert.equal(currentCropPrice(result, "wheat"), currentCropPrice(pgGlobal, "wheat"));
  assert.equal(result.marketMultiplier, 1.5);
});

test("resolveMarket D. plusieurs cultures : les prix (currentCropPrice de farm.ts) different correctement selon le basePrice de chaque culture, meme GlobalState", async () => {
  const pgGlobal = buildGlobalState({ marketMultiplier: 2 });
  const deps = buildMarketDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => pgGlobal });

  const result = await resolveMarket(TEST_PLAYER_ID, buildFakeStoreForMarket(buildGlobalState()), deps);

  const wheatPrice = currentCropPrice(result, "wheat");
  const carrotPrice = currentCropPrice(result, "carrot");
  const chorusPrice = currentCropPrice(result, "chorus_fruit");
  assert.equal(wheatPrice, currentCropPrice(pgGlobal, "wheat"));
  assert.equal(carrotPrice, currentCropPrice(pgGlobal, "carrot"));
  assert.equal(chorusPrice, currentCropPrice(pgGlobal, "chorus_fruit"));
  assert.ok(wheatPrice < carrotPrice && carrotPrice < chorusPrice, "des cultures de basePrice croissant doivent produire des prix croissants");
});

test("resolveMarket E. GlobalState Postgres different du JSON : le resultat correspond au Postgres, preuve qu'aucun melange des deux sources n'est possible", async () => {
  const jsonGlobal = buildGlobalState({ marketMultiplier: 1, previousMarketMultiplier: 1 });
  const pgGlobal = buildGlobalState({ marketMultiplier: 3, previousMarketMultiplier: 1 });
  const store = buildFakeStoreForMarket(jsonGlobal);

  const v1 = await resolveMarket(TEST_PLAYER_ID, store, buildMarketDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveMarket(
    TEST_PLAYER_ID,
    store,
    buildMarketDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => pgGlobal }),
  );

  assert.equal(v1, jsonGlobal);
  assert.equal(pg, pgGlobal);
  assert.notEqual(
    currentCropPrice(v1, "wheat"),
    currentCropPrice(pg, "wheat"),
    "les deux marketMultiplier sont volontairement differents (1 vs 3) : les prix DOIVENT differer, preuve que pg est bien utilise, jamais jsonGlobal cote Postgres",
  );
});

test("resolveMarket F. GlobalState Postgres absent : erreur explicite, aucun fallback JSON silencieux", async () => {
  const store = buildFakeStoreForMarket(buildGlobalState());
  const deps = buildMarketDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => null });

  await assert.rejects(() => resolveMarket(TEST_PLAYER_ID, store, deps), /global_state introuvable/);
});

test("resolveMarket G. /market est GLOBAL-ONLY : ensurePlayerExists/getPlayer n'existent meme pas dans MarketResolutionDeps, aucun bootstrap joueur possible", async () => {
  // Preuve structurelle : MarketResolutionDeps ne declare que
  // shouldUsePostgresRuntime/getGlobalState -- ce test verifie que l'objet
  // reellement passe a resolveMarket() (buildMarketDeps(), sans override
  // ensurePlayerExists/getPlayer) ne contient aucune de ces deux cles.
  const deps = buildMarketDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => buildGlobalState() });

  assert.ok(!("ensurePlayerExists" in deps), "MarketResolutionDeps ne doit jamais accepter ensurePlayerExists");
  assert.ok(!("getPlayer" in deps), "MarketResolutionDeps ne doit jamais accepter getPlayer");

  await resolveMarket(TEST_PLAYER_ID, buildFakeStoreForMarket(buildGlobalState()), deps);
});

// ===========================================================================
// H. Audit anti-divergence (LOT 6) : shouldUsePostgresRuntime doit apparaitre
// EXACTEMENT 11 fois (le garde-fou de preambule + resolveBuyUpgrade +
// resolveDailyClaim + resolvePlantCrop + resolveCraftItem +
// resolveHarvestCrops + resolveSellItems + resolveInventory +
// resolveFarmView + resolveProfile + resolveMarket) ; ensurePlayerExists
// EXACTEMENT 9 fois -- INCHANGE depuis /profile, ce qui PROUVE que
// resolveMarket() n'appelle jamais ensurePlayerExists (resolveBuyUpgrade +
// resolveDailyClaim + resolvePlantCrop + resolveCraftItem +
// resolveHarvestCrops + resolveSellItems + resolveInventory +
// resolveFarmView + resolveProfile) ; buyPlayerUpgrade, claimPlayerDaily,
// plantPlayerCrop, craftPlayerItem, harvestPlayerCrops et sellPlayerItems
// EXACTEMENT 1 fois chacun (leur seule fonction de resolution respective).
// deps.getPlayer( (le repository, pas store.getPlayer) EXACTEMENT 4 fois --
// INCHANGE depuis /profile, ce qui PROUVE que resolveMarket() n'appelle
// jamais deps.getPlayer non plus (resolvePlantCrop + resolveInventory +
// resolveFarmView + resolveProfile) ; deps.getGlobalState( EXACTEMENT 4
// fois (resolveInventory + resolveFarmView + resolveProfile +
// resolveMarket). Preuve automatisee (lecture du fichier source, meme
// technique que les tests transversaux existants de
// farmRepository.test.ts/farmPlayerActions.test.ts) qu'aucune autre
// commande (/contract, etc.) n'a ete branchee sur Postgres par erreur, et
// que /buy, /daily, /plant, /craft, /harvest, /sell, /inventory, /farm,
// /profile et /market sont desormais les DIX SEULS chemins Postgres.
// ===========================================================================

test("presenters.ts : shouldUsePostgresRuntime/ensurePlayerExists/buyPlayerUpgrade/claimPlayerDaily/plantPlayerCrop/craftPlayerItem/harvestPlayerCrops/sellPlayerItems/getPlayer/getGlobalState n'ont que les sites d'appel attendus, aucune autre commande", async () => {
  const source = await readFile(new URL("./presenters.ts", import.meta.url), "utf8");
  const countCalls = (name: string) => (source.match(new RegExp(`${name}\\(`, "g")) ?? []).length;

  assert.equal(
    countCalls("shouldUsePostgresRuntime"),
    11,
    "11 sites d'appel attendus : garde-fou de preambule + resolveBuyUpgrade + resolveDailyClaim + resolvePlantCrop + resolveCraftItem + resolveHarvestCrops + resolveSellItems + resolveInventory + resolveFarmView + resolveProfile + resolveMarket",
  );
  assert.equal(countCalls("harvestPlayerCrops"), 1, "un seul site d'appel attendu (resolveHarvestCrops)");
  assert.equal(countCalls("sellPlayerItems"), 1, "un seul site d'appel attendu (resolveSellItems)");
  assert.equal(
    countCalls("ensurePlayerExists"),
    9,
    "9 sites d'appel attendus, INCHANGE depuis /profile -- resolveMarket() n'appelle jamais ensurePlayerExists (resolveBuyUpgrade + resolveDailyClaim + resolvePlantCrop + resolveCraftItem + resolveHarvestCrops + resolveSellItems + resolveInventory + resolveFarmView + resolveProfile)",
  );
  assert.equal(countCalls("buyPlayerUpgrade"), 1, "un seul site d'appel attendu (resolveBuyUpgrade)");
  assert.equal(countCalls("claimPlayerDaily"), 1, "un seul site d'appel attendu (resolveDailyClaim)");
  assert.equal(countCalls("plantPlayerCrop"), 1, "un seul site d'appel attendu (resolvePlantCrop)");
  assert.equal(countCalls("craftPlayerItem"), 1, "un seul site d'appel attendu (resolveCraftItem)");
  // "deps.getPlayer(" exclut deliberement "store.getPlayer(" (compte a part,
  // deja verifie test par test ci-dessus) -- seul le repository nous
  // interesse ici, pas la methode FarmStore preexistante.
  assert.equal(
    countCalls("deps.getPlayer"),
    4,
    "quatre sites d'appel du repository getPlayer attendus, INCHANGE depuis /profile -- resolveMarket() n'appelle jamais deps.getPlayer (resolvePlantCrop + resolveInventory + resolveFarmView + resolveProfile)",
  );
  assert.equal(countCalls("deps.getGlobalState"), 4, "quatre sites d'appel du repository getGlobalState attendus (resolveInventory + resolveFarmView + resolveProfile + resolveMarket)");
});

// ===========================================================================
// I. Preambule enrichGlobalState/store.save() -- ne doit JAMAIS s'executer
// pour /buy, /daily, /plant, /craft, /harvest, /sell, /inventory, /farm,
// /profile ou /market d'un joueur allowliste (aucune ecriture JSON), mais
// DOIT continuer a s'executer exactement comme avant pour toute autre
// commande (V1 inchange). commandSkipsJsonPreamble() est la decision PURE
// qui gouverne ce garde-fou -- testee ici directement (aucune connexion DB
// necessaire). handleSlashCommand("list") verifie separement, en bout en
// bout, qu'une commande V1 declenche toujours reellement le preambule.
// ===========================================================================

test("commandSkipsJsonPreamble : true UNIQUEMENT pour /buy, /daily, /plant, /craft, /harvest, /sell, /inventory, /farm, /profile ou /market d'un joueur allowliste, jamais pour une autre commande ni un joueur non allowliste", () => {
  const allowlisted = { shouldUsePostgresRuntime: () => true };
  const notAllowlisted = { shouldUsePostgresRuntime: () => false };

  assert.equal(commandSkipsJsonPreamble("buy", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("daily", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("plant", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("craft", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("harvest", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("sell", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("inventory", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("farm", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("profile", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("market", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("buy", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("daily", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("plant", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("craft", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("harvest", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("sell", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("inventory", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("farm", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("profile", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("market", TEST_PLAYER_ID, notAllowlisted), false);
  // Meme allowliste, une commande jamais branchee sur Postgres reste V1 --
  // le preambule doit continuer a s'executer pour elle, sans exception.
  assert.equal(commandSkipsJsonPreamble("contract", TEST_PLAYER_ID, allowlisted), false);
  assert.equal(commandSkipsJsonPreamble("leaderboard", TEST_PLAYER_ID, allowlisted), false);
});

// Interaction discord.js minimale -- uniquement les champs lus par
// handleSlashCommand("list") (aucune donnee joueur, aucune connexion DB
// possible sur ce chemin).
function buildListInteraction(userId: string): ChatInputCommandInteraction {
  return {
    commandName: "list",
    user: { id: userId },
    replied: false,
    deferred: false,
    reply: async () => {},
  } as unknown as ChatInputCommandInteraction;
}

test("handleSlashCommand G. commande V1 (list, jamais routee vers Postgres) : enrichGlobalState/store.save() se declenchent exactement comme avant", async () => {
  // marketUpdatedAt tres ancien (epoch 0) : garantit enrichGlobalState(...)
  // === true de maniere deterministe (fonction reelle de farm.ts, non
  // mockee), donc store.save() DOIT etre appele pour une commande V1.
  const global = defaultGlobalState(0);
  const save = mock.fn(async () => {});
  const store = { global, save } as unknown as FarmStore;

  await handleSlashCommand(buildListInteraction(TEST_PLAYER_ID), store);

  assert.equal(save.mock.calls.length, 1, "le preambule doit toujours sauvegarder pour une commande non routee vers Postgres");
});
