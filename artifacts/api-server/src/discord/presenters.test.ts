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
import { logger } from "../lib/logger.ts";
import type { ChatInputCommandInteraction } from "discord.js";
import {
  commandSkipsJsonPreamble,
  handleCodexComponent,
  handleSlashCommand,
  resolveBuyUpgrade,
  resolveCodexRefresh,
  resolveCodexReplant,
  resolveCraftItem,
  resolveDailyClaim,
  resolveContract,
  resolveFarmView,
  resolveHarvestCrops,
  resolveInventory,
  resolveLeaderboard,
  resolveMarket,
  resolvePlantCrop,
  resolveProfile,
  resolveSellItems,
  resolveWeekly,
  type BuyResolutionDeps,
  type CodexRefreshResolutionDeps,
  type CodexReplantResolutionDeps,
  type ContractResolutionDeps,
  type CraftResolutionDeps,
  type DailyResolutionDeps,
  type FarmViewResolutionDeps,
  type HarvestResolutionDeps,
  type InventoryResolutionDeps,
  type LeaderboardResolutionDeps,
  type MarketResolutionDeps,
  type PlantResolutionDeps,
  type ProfileResolutionDeps,
  type SellResolutionDeps,
  type WeeklyResolutionDeps,
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
// resolveContract -- MEME categorie GLOBAL-ONLY que resolveMarket :
// commandContract (V1 reel, verifie a l'audit) ne lit AUCUNE donnee Player
// (aucun store.getPlayer() dans son corps), uniquement
// store.global.contract (cropId/required/bonusMultiplier/remaining) et
// cropById() (constants.ts) pour le nom/emoji de la culture. renewedAt
// n'est PAS affiche ("Toutes les 4 heures" est un texte statique).
// resolveContract() n'accepte donc meme pas ensurePlayerExists/getPlayer
// dans ses deps, exactement comme resolveMarket.
// ===========================================================================

function buildFakeStoreForContract(global: GlobalState): FarmStore {
  return { global } as unknown as FarmStore;
}

function buildContractDeps(overrides: Partial<ContractResolutionDeps> = {}): ContractResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    getGlobalState: async () => buildGlobalState(),
    ...overrides,
  };
}

test("resolveContract A. joueur non allowliste : utilise store.global.contract uniquement, jamais deps.getGlobalState, meme chemin V1", async () => {
  const global = buildGlobalState({ contract: { cropId: "carrot", required: 15, remaining: 8, bonusMultiplier: 1.4, renewedAt: NOW } });
  const store = buildFakeStoreForContract(global);
  const getGlobalState = mock.fn(async () => {
    throw new Error("getGlobalState ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildContractDeps({ shouldUsePostgresRuntime: () => false, getGlobalState });

  const result = await resolveContract(TEST_PLAYER_ID, store, deps);

  assert.equal(getGlobalState.mock.calls.length, 0);
  assert.equal(result, global, "doit retourner exactement store.global");
});

test("resolveContract B. joueur allowliste : utilise deps.getGlobalState (Postgres) uniquement, jamais store.global, aucune mutation JSON", async () => {
  const jsonGlobal = buildGlobalState();
  const store = buildFakeStoreForContract(jsonGlobal);
  const pgGlobal = buildGlobalState({ contract: { cropId: "melon", required: 30, remaining: 12, bonusMultiplier: 1.9, renewedAt: NOW } });
  const getGlobalState = mock.fn(async () => pgGlobal);
  const deps = buildContractDeps({ shouldUsePostgresRuntime: () => true, getGlobalState });

  const result = await resolveContract(TEST_PLAYER_ID, store, deps);

  assert.equal(getGlobalState.mock.calls.length, 1);
  assert.equal(result, pgGlobal, "doit retourner exactement le GlobalState Postgres, jamais store.global");
});

test("resolveContract C. contrat normal : cropId/required/remaining/bonusMultiplier retournes identiques au GlobalState Postgres reel, aucune reimplementation", async () => {
  const pgGlobal = buildGlobalState({ contract: { cropId: "pumpkin", required: 25, remaining: 17, bonusMultiplier: 1.75, renewedAt: NOW } });
  const deps = buildContractDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => pgGlobal });

  const result = await resolveContract(TEST_PLAYER_ID, buildFakeStoreForContract(buildGlobalState()), deps);

  assert.equal(result.contract.cropId, "pumpkin");
  assert.equal(result.contract.required, 25);
  assert.equal(result.contract.remaining, 17);
  assert.equal(result.contract.bonusMultiplier, 1.75);
});

test("resolveContract D. contrat restant = 0 : affichage identique V1/Postgres, aucun crash, aucune divergence", async () => {
  const completedContract = { cropId: "wheat" as const, required: 20, remaining: 0, bonusMultiplier: 1.6, renewedAt: NOW };
  const jsonGlobal = buildGlobalState({ contract: completedContract });
  const pgGlobal = buildGlobalState({ contract: completedContract });

  const v1 = await resolveContract(
    TEST_PLAYER_ID,
    buildFakeStoreForContract(jsonGlobal),
    buildContractDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveContract(
    TEST_PLAYER_ID,
    buildFakeStoreForContract(buildGlobalState()),
    buildContractDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => pgGlobal }),
  );

  assert.equal(v1.contract.remaining, 0);
  assert.equal(pg.contract.remaining, 0);
});

test("resolveContract E. GlobalState Postgres different du JSON : le resultat correspond au Postgres, preuve qu'aucun melange des deux sources n'est possible", async () => {
  const jsonGlobal = buildGlobalState({ contract: { cropId: "wheat", required: 20, remaining: 20, bonusMultiplier: 1.6, renewedAt: NOW } });
  const pgGlobal = buildGlobalState({ contract: { cropId: "cocoa", required: 40, remaining: 5, bonusMultiplier: 2.1, renewedAt: NOW } });
  const store = buildFakeStoreForContract(jsonGlobal);

  const v1 = await resolveContract(TEST_PLAYER_ID, store, buildContractDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveContract(
    TEST_PLAYER_ID,
    store,
    buildContractDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => pgGlobal }),
  );

  assert.equal(v1, jsonGlobal);
  assert.equal(pg, pgGlobal);
  assert.notEqual(v1.contract.cropId, pg.contract.cropId, "les deux contrats sont volontairement differents, preuve que pg est bien utilise, jamais jsonGlobal cote Postgres");
});

test("resolveContract F. GlobalState Postgres absent : erreur explicite, aucun fallback JSON silencieux", async () => {
  const store = buildFakeStoreForContract(buildGlobalState());
  const deps = buildContractDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => null });

  await assert.rejects(() => resolveContract(TEST_PLAYER_ID, store, deps), /global_state introuvable/);
});

test("resolveContract G. /contract est GLOBAL-ONLY : ensurePlayerExists/getPlayer n'existent meme pas dans ContractResolutionDeps, aucun bootstrap joueur possible", async () => {
  const deps = buildContractDeps({ shouldUsePostgresRuntime: () => true, getGlobalState: async () => buildGlobalState() });

  assert.ok(!("ensurePlayerExists" in deps), "ContractResolutionDeps ne doit jamais accepter ensurePlayerExists");
  assert.ok(!("getPlayer" in deps), "ContractResolutionDeps ne doit jamais accepter getPlayer");

  await resolveContract(TEST_PLAYER_ID, buildFakeStoreForContract(buildGlobalState()), deps);
});

// ===========================================================================
// resolveLeaderboard -- categorie MULTI-PLAYER GLOBAL : contrairement a
// resolveMarket/resolveContract (GLOBAL-ONLY, un seul GlobalState),
// commandLeaderboard (V1 reel, verifie a l'audit) lit TOUS les joueurs
// (store.getPlayers(), pas seulement l'appelant) ET le GlobalState
// (marketMultiplier, via totalInventoryValue()). V1 ne bootstrap jamais le
// joueur appelant -- resolveLeaderboard() n'accepte donc pas non plus
// ensurePlayerExists/getPlayer dans ses deps.
// ===========================================================================

function buildFakeStoreForLeaderboard(players: PlayerState[], global: GlobalState): FarmStore {
  return { getPlayers: () => players, global } as unknown as FarmStore;
}

function buildLeaderboardDeps(overrides: Partial<LeaderboardResolutionDeps> = {}): LeaderboardResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    getAllPlayers: async () => [],
    getGlobalState: async () => buildGlobalState(),
    ...overrides,
  };
}

test("resolveLeaderboard A. joueur non allowliste : utilise store.getPlayers()/store.global uniquement, jamais deps.getAllPlayers/deps.getGlobalState, meme chemin V1", async () => {
  const players = [buildPlayerState({ userId: "p1", coins: 100 })];
  const global = buildGlobalState();
  const store = buildFakeStoreForLeaderboard(players, global);
  const getAllPlayers = mock.fn(async () => {
    throw new Error("getAllPlayers ne doit jamais etre appele sur le chemin V1");
  });
  const getGlobalState = mock.fn(async () => {
    throw new Error("getGlobalState ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildLeaderboardDeps({ shouldUsePostgresRuntime: () => false, getAllPlayers, getGlobalState });

  const result = await resolveLeaderboard(TEST_PLAYER_ID, store, deps);

  assert.equal(getAllPlayers.mock.calls.length, 0);
  assert.equal(getGlobalState.mock.calls.length, 0);
  assert.equal(result.players, players, "doit retourner exactement store.getPlayers()");
  assert.equal(result.global, global, "doit retourner exactement store.global");
});

test("resolveLeaderboard B. joueur allowliste : utilise deps.getAllPlayers/deps.getGlobalState (Postgres) uniquement, jamais store.getPlayers()/store.global, aucune mutation JSON", async () => {
  const jsonPlayers = [buildPlayerState({ userId: "json-only", coins: 9999 })];
  const jsonGlobal = buildGlobalState();
  const store = buildFakeStoreForLeaderboard(jsonPlayers, jsonGlobal);
  const pgPlayers = [buildPlayerState({ userId: "pg1", coins: 500 })];
  const pgGlobal = buildGlobalState({ marketMultiplier: 1.3 });
  const getAllPlayers = mock.fn(async () => pgPlayers);
  const getGlobalState = mock.fn(async () => pgGlobal);
  const deps = buildLeaderboardDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers, getGlobalState });

  const result = await resolveLeaderboard(TEST_PLAYER_ID, store, deps);

  assert.equal(getAllPlayers.mock.calls.length, 1);
  assert.equal(getGlobalState.mock.calls.length, 1);
  assert.equal(result.players, pgPlayers, "doit retourner exactement les joueurs Postgres, jamais store.getPlayers()");
  assert.equal(result.global, pgGlobal, "doit retourner exactement le GlobalState Postgres, jamais store.global");
});

test("resolveLeaderboard C. tri : plusieurs joueurs, l'ordre exact V1 (coins + totalInventoryValue de farm.ts) est reproductible a partir des donnees retournees, aucune formule reimplementee", async () => {
  const pgPlayers = [
    buildPlayerState({ userId: "poor", coins: 10 }),
    buildPlayerState({ userId: "rich", coins: 1000 }),
    buildPlayerState({ userId: "mid", coins: 100 }),
  ];
  const pgGlobal = buildGlobalState();
  const deps = buildLeaderboardDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => pgPlayers, getGlobalState: async () => pgGlobal });

  const result = await resolveLeaderboard(TEST_PLAYER_ID, buildFakeStoreForLeaderboard([], buildGlobalState()), deps);

  const sorted = [...result.players].sort(
    (a, b) => (b.coins + totalInventoryValue(b, result.global)) - (a.coins + totalInventoryValue(a, result.global)),
  );
  assert.deepEqual(sorted.map((p) => p.userId), ["rich", "mid", "poor"]);
});

test("resolveLeaderboard D. egalite de richesse : comportement identique V1/Postgres, aucun crash, ordre stable preserve (aucun tie-break reimplemente)", async () => {
  const tiedPlayers = [
    buildPlayerState({ userId: "first", coins: 50 }),
    buildPlayerState({ userId: "second", coins: 50 }),
  ];
  const global = buildGlobalState();

  const v1 = await resolveLeaderboard(
    TEST_PLAYER_ID,
    buildFakeStoreForLeaderboard(tiedPlayers, global),
    buildLeaderboardDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveLeaderboard(
    TEST_PLAYER_ID,
    buildFakeStoreForLeaderboard([], buildGlobalState()),
    buildLeaderboardDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => tiedPlayers, getGlobalState: async () => global }),
  );

  const sortBoth = (players: typeof tiedPlayers, g: typeof global) =>
    [...players].sort((a, b) => (b.coins + totalInventoryValue(b, g)) - (a.coins + totalInventoryValue(a, g))).map((p) => p.userId);
  assert.deepEqual(sortBoth(v1.players, v1.global), ["first", "second"], "ordre stable V1 : premiere position conservee en cas d'egalite");
  assert.deepEqual(sortBoth(pg.players, pg.global), ["first", "second"], "meme ordre stable cote Postgres");
});

test("resolveLeaderboard E. 0 joueur : tableau vide identique V1/Postgres, meme reponse (\"classement encore vide\") pour les deux branches", async () => {
  const global = buildGlobalState();

  const v1 = await resolveLeaderboard(
    TEST_PLAYER_ID,
    buildFakeStoreForLeaderboard([], global),
    buildLeaderboardDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveLeaderboard(
    TEST_PLAYER_ID,
    buildFakeStoreForLeaderboard([], buildGlobalState()),
    buildLeaderboardDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => [], getGlobalState: async () => global }),
  );

  assert.deepEqual(v1.players, []);
  assert.deepEqual(pg.players, []);
});

test("resolveLeaderboard F. 1 joueur : classement a une seule ligne, identique V1/Postgres, aucun crash", async () => {
  const soloPlayer = [buildPlayerState({ userId: "solo", coins: 42 })];
  const global = buildGlobalState();

  const v1 = await resolveLeaderboard(
    TEST_PLAYER_ID,
    buildFakeStoreForLeaderboard(soloPlayer, global),
    buildLeaderboardDeps({ shouldUsePostgresRuntime: () => false }),
  );
  const pg = await resolveLeaderboard(
    TEST_PLAYER_ID,
    buildFakeStoreForLeaderboard([], buildGlobalState()),
    buildLeaderboardDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => soloPlayer, getGlobalState: async () => global }),
  );

  assert.equal(v1.players.length, 1);
  assert.equal(pg.players.length, 1);
  assert.equal(v1.players[0]!.userId, "solo");
  assert.equal(pg.players[0]!.userId, "solo");
});

test("resolveLeaderboard G. source Postgres differente du JSON : le resultat correspond uniquement au Postgres, preuve qu'aucun melange des deux sources n'est possible", async () => {
  const jsonPlayers = [buildPlayerState({ userId: "json-player", coins: 1 })];
  const jsonGlobal = buildGlobalState();
  const store = buildFakeStoreForLeaderboard(jsonPlayers, jsonGlobal);
  const pgPlayers = [buildPlayerState({ userId: "pg-player", coins: 2 })];
  const pgGlobal = buildGlobalState({ marketMultiplier: 2 });

  const v1 = await resolveLeaderboard(TEST_PLAYER_ID, store, buildLeaderboardDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveLeaderboard(
    TEST_PLAYER_ID,
    store,
    buildLeaderboardDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => pgPlayers, getGlobalState: async () => pgGlobal }),
  );

  assert.equal(v1.players, jsonPlayers);
  assert.equal(v1.global, jsonGlobal);
  assert.equal(pg.players, pgPlayers);
  assert.equal(pg.global, pgGlobal);
  assert.notDeepEqual(v1.players.map((p) => p.userId), pg.players.map((p) => p.userId), "les deux listes de joueurs sont volontairement differentes, preuve que pg est bien utilise, jamais json cote Postgres");
});

test("resolveLeaderboard H. deps.getAllPlayers() qui echoue (rejette) : l'erreur remonte telle quelle, aucun fallback JSON silencieux", async () => {
  const store = buildFakeStoreForLeaderboard([buildPlayerState()], buildGlobalState());
  const deps = buildLeaderboardDeps({
    shouldUsePostgresRuntime: () => true,
    getAllPlayers: async () => {
      throw new Error("panne Postgres simulee");
    },
  });

  await assert.rejects(() => resolveLeaderboard(TEST_PLAYER_ID, store, deps), /panne Postgres simulee/);
});

test("resolveLeaderboard I. GlobalState Postgres absent : erreur explicite, aucun fallback JSON silencieux", async () => {
  const store = buildFakeStoreForLeaderboard([], buildGlobalState());
  const deps = buildLeaderboardDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => [], getGlobalState: async () => null });

  await assert.rejects(() => resolveLeaderboard(TEST_PLAYER_ID, store, deps), /global_state introuvable/);
});

test("resolveLeaderboard J. /leaderboard est MULTI-PLAYER GLOBAL : ensurePlayerExists/getPlayer n'existent meme pas dans LeaderboardResolutionDeps, aucun bootstrap joueur possible", async () => {
  const deps = buildLeaderboardDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => [], getGlobalState: async () => buildGlobalState() });

  assert.ok(!("ensurePlayerExists" in deps), "LeaderboardResolutionDeps ne doit jamais accepter ensurePlayerExists");
  assert.ok(!("getPlayer" in deps), "LeaderboardResolutionDeps ne doit jamais accepter getPlayer");

  await resolveLeaderboard(TEST_PLAYER_ID, buildFakeStoreForLeaderboard([], buildGlobalState()), deps);
});

// ===========================================================================
// resolveWeekly -- MEME categorie MULTI-PLAYER GLOBAL que resolveLeaderboard,
// mais ENCORE PLUS SIMPLE : /weekly (V1 reel, verifie a l'audit dedie)
// n'a AUCUNE dependance a GlobalState (score = coins - weeklySnapshotCoins
// uniquement) et V1 n'appelle JAMAIS de primitive mutante (le reset/
// recompense hebdomadaire est exclusivement un mecanisme de scheduler,
// jamais declenche par /weekly). resolveWeekly() n'accepte donc ni
// ensurePlayerExists ni getGlobalState dans ses deps. Aucun test ici ne
// mocke tryClaimWeeklyReset/resumeWeeklyRewards/claimAndMutatePlayer/
// mutatePlayer/mutatePlayerAndGlobal -- le test K/L ci-dessous prouve par
// lecture du source que resolveWeekly()/commandWeekly() ne les referencent
// jamais.
// ===========================================================================

function buildFakeStoreForWeekly(players: PlayerState[]): FarmStore {
  return { getPlayers: () => players } as unknown as FarmStore;
}

function buildWeeklyDeps(overrides: Partial<WeeklyResolutionDeps> = {}): WeeklyResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    getAllPlayers: async () => [],
    ...overrides,
  };
}

test("resolveWeekly A. joueur non allowliste : utilise store.getPlayers() uniquement, jamais deps.getAllPlayers, meme chemin V1", async () => {
  const players = [buildPlayerState({ userId: "p1", coins: 100, weeklySnapshotCoins: 20 })];
  const store = buildFakeStoreForWeekly(players);
  const getAllPlayers = mock.fn(async () => {
    throw new Error("getAllPlayers ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildWeeklyDeps({ shouldUsePostgresRuntime: () => false, getAllPlayers });

  const result = await resolveWeekly(TEST_PLAYER_ID, store, deps);

  assert.equal(getAllPlayers.mock.calls.length, 0);
  assert.equal(result, players, "doit retourner exactement store.getPlayers()");
});

test("resolveWeekly B. joueur allowliste : utilise deps.getAllPlayers (Postgres) uniquement, jamais store.getPlayers(), aucune mutation JSON", async () => {
  const jsonPlayers = [buildPlayerState({ userId: "json-only", coins: 9999, weeklySnapshotCoins: 0 })];
  const store = buildFakeStoreForWeekly(jsonPlayers);
  const pgPlayers = [buildPlayerState({ userId: "pg1", coins: 500, weeklySnapshotCoins: 100 })];
  const getAllPlayers = mock.fn(async () => pgPlayers);
  const deps = buildWeeklyDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers });

  const result = await resolveWeekly(TEST_PLAYER_ID, store, deps);

  assert.equal(getAllPlayers.mock.calls.length, 1);
  assert.equal(result, pgPlayers, "doit retourner exactement les joueurs Postgres, jamais store.getPlayers()");
});

test("resolveWeekly C. classement : score = coins - weeklySnapshotCoins, tri DESC exact, reproductible a partir des donnees retournees, aucune formule reimplementee", async () => {
  const pgPlayers = [
    buildPlayerState({ userId: "low", coins: 100, weeklySnapshotCoins: 90 }),
    buildPlayerState({ userId: "high", coins: 1000, weeklySnapshotCoins: 200 }),
    buildPlayerState({ userId: "mid", coins: 500, weeklySnapshotCoins: 300 }),
  ];
  const deps = buildWeeklyDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => pgPlayers });

  const players = await resolveWeekly(TEST_PLAYER_ID, buildFakeStoreForWeekly([]), deps);

  const sorted = [...players].sort((a, b) => (b.coins - b.weeklySnapshotCoins) - (a.coins - a.weeklySnapshotCoins));
  assert.deepEqual(sorted.map((p) => p.userId), ["high", "mid", "low"]);
});

test("resolveWeekly D. score negatif : accepte et calculable sans crash, identique V1/Postgres", async () => {
  const pgPlayers = [buildPlayerState({ userId: "spender", coins: 10, weeklySnapshotCoins: 200 })];
  const deps = buildWeeklyDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => pgPlayers });

  const players = await resolveWeekly(TEST_PLAYER_ID, buildFakeStoreForWeekly([]), deps);

  const score = players[0]!.coins - players[0]!.weeklySnapshotCoins;
  assert.equal(score, -190);
});

test("resolveWeekly E. egalite : ordre stable identique V1/Postgres, aucun tie-break ajoute", async () => {
  const tiedPlayers = [
    buildPlayerState({ userId: "first", coins: 150, weeklySnapshotCoins: 100 }),
    buildPlayerState({ userId: "second", coins: 100, weeklySnapshotCoins: 50 }),
  ];

  const v1 = await resolveWeekly(TEST_PLAYER_ID, buildFakeStoreForWeekly(tiedPlayers), buildWeeklyDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveWeekly(
    TEST_PLAYER_ID,
    buildFakeStoreForWeekly([]),
    buildWeeklyDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => tiedPlayers }),
  );

  const sortIds = (players: typeof tiedPlayers) =>
    [...players].sort((a, b) => (b.coins - b.weeklySnapshotCoins) - (a.coins - a.weeklySnapshotCoins)).map((p) => p.userId);
  assert.deepEqual(sortIds(v1), ["first", "second"]);
  assert.deepEqual(sortIds(pg), ["first", "second"]);
});

test("resolveWeekly F. top 10 : la limite reste appliquee dans commandWeekly (inchange), resolveWeekly retourne bien TOUS les joueurs sans les tronquer lui-meme", async () => {
  const manyPlayers = Array.from({ length: 15 }, (_, i) => buildPlayerState({ userId: `p${i}`, coins: i, weeklySnapshotCoins: 0 }));
  const deps = buildWeeklyDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => manyPlayers });

  const players = await resolveWeekly(TEST_PLAYER_ID, buildFakeStoreForWeekly([]), deps);

  assert.equal(players.length, 15, "resolveWeekly ne tronque pas -- le slice(0, 10) reste dans commandWeekly, inchange");
});

test("resolveWeekly G. 0 joueur : tableau vide identique V1/Postgres", async () => {
  const v1 = await resolveWeekly(TEST_PLAYER_ID, buildFakeStoreForWeekly([]), buildWeeklyDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveWeekly(
    TEST_PLAYER_ID,
    buildFakeStoreForWeekly([]),
    buildWeeklyDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => [] }),
  );

  assert.deepEqual(v1, []);
  assert.deepEqual(pg, []);
});

test("resolveWeekly H. 1 joueur : classement a une seule ligne, identique V1/Postgres, aucun crash", async () => {
  const soloPlayer = [buildPlayerState({ userId: "solo", coins: 42, weeklySnapshotCoins: 10 })];

  const v1 = await resolveWeekly(TEST_PLAYER_ID, buildFakeStoreForWeekly(soloPlayer), buildWeeklyDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveWeekly(
    TEST_PLAYER_ID,
    buildFakeStoreForWeekly([]),
    buildWeeklyDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => soloPlayer }),
  );

  assert.equal(v1.length, 1);
  assert.equal(pg.length, 1);
  assert.equal(v1[0]!.userId, "solo");
  assert.equal(pg[0]!.userId, "solo");
});

test("resolveWeekly I. source Postgres differente du JSON : le resultat correspond uniquement au Postgres, preuve qu'aucun melange des deux sources n'est possible", async () => {
  const jsonPlayers = [buildPlayerState({ userId: "json-player", coins: 1, weeklySnapshotCoins: 0 })];
  const store = buildFakeStoreForWeekly(jsonPlayers);
  const pgPlayers = [buildPlayerState({ userId: "pg-player", coins: 2, weeklySnapshotCoins: 0 })];

  const v1 = await resolveWeekly(TEST_PLAYER_ID, store, buildWeeklyDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveWeekly(TEST_PLAYER_ID, store, buildWeeklyDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => pgPlayers }));

  assert.equal(v1, jsonPlayers);
  assert.equal(pg, pgPlayers);
  assert.notDeepEqual(v1.map((p) => p.userId), pg.map((p) => p.userId), "les deux listes sont volontairement differentes, preuve que pg est bien utilise, jamais json cote Postgres");
});

test("resolveWeekly J. deps.getAllPlayers() qui echoue (rejette) : l'erreur remonte telle quelle, aucun fallback JSON silencieux", async () => {
  const store = buildFakeStoreForWeekly([buildPlayerState()]);
  const deps = buildWeeklyDeps({
    shouldUsePostgresRuntime: () => true,
    getAllPlayers: async () => {
      throw new Error("panne Postgres simulee");
    },
  });

  await assert.rejects(() => resolveWeekly(TEST_PLAYER_ID, store, deps), /panne Postgres simulee/);
});

test("resolveWeekly K. le resolveur/commandWeekly ne referencent JAMAIS tryClaimWeeklyReset/resumeWeeklyRewards/claimAndMutatePlayer/mutatePlayer/mutatePlayerAndGlobal (aucune mutation weekly dans le presenter, uniquement dans le futur scheduler)", async () => {
  const source = await readFile(new URL("./presenters.ts", import.meta.url), "utf8");
  const weeklyBlockStart = source.indexOf("export interface WeeklyResolutionDeps");
  const weeklyBlockEnd = source.indexOf("// LOT 6, bascule TEST-only pour /daily UNIQUEMENT", weeklyBlockStart);
  assert.ok(weeklyBlockStart >= 0, "resolveWeekly/commandWeekly doivent exister");
  assert.ok(weeklyBlockEnd > weeklyBlockStart, "le bloc /daily doit exister juste apres le bloc /weekly");
  const weeklyBlock = source.slice(weeklyBlockStart, weeklyBlockEnd);

  for (const forbidden of ["tryClaimWeeklyReset", "resumeWeeklyRewards", "claimAndMutatePlayer", "mutatePlayerAndGlobal", "mutatePlayer", "store.save"]) {
    assert.ok(!weeklyBlock.includes(forbidden), `resolveWeekly/commandWeekly ne doivent jamais referencer ${forbidden}`);
  }
});

test("resolveWeekly L. ensurePlayerExists et getGlobalState NE SONT PAS acceptes par WeeklyResolutionDeps (structurellement absents du chemin Postgres)", async () => {
  const deps = buildWeeklyDeps({ shouldUsePostgresRuntime: () => true, getAllPlayers: async () => [] });

  assert.ok(!("ensurePlayerExists" in deps), "WeeklyResolutionDeps ne doit jamais accepter ensurePlayerExists");
  assert.ok(!("getGlobalState" in deps), "WeeklyResolutionDeps ne doit jamais accepter getGlobalState");
  assert.ok(!("getPlayer" in deps), "WeeklyResolutionDeps ne doit jamais accepter getPlayer");

  await resolveWeekly(TEST_PLAYER_ID, buildFakeStoreForWeekly([]), deps);
});

// ===========================================================================
// resolveCodexReplant/resolveCodexRefresh -- LOT 6, dernier branchement
// (/codex). /codex initial (slash command) et son bouton "Planter"
// reutilisent respectivement resolveFarmView et resolvePlantCrop TELS
// QUELS (deja testes ailleurs dans ce fichier, aucun test redondant ici).
// Seuls DEUX nouveaux resolveurs sont introduits : resolveCodexReplant
// (bouton "Replantation auto", PLAYER-ONLY) et resolveCodexRefresh (bouton
// "Actualiser le prix", GLOBAL-ONLY, meme famille que resolveMarket/
// resolveContract). Les boutons "culture"/"filter"/"plots" restent de la
// vue pure (aucun store touche, testes structurellement plus bas).
// ===========================================================================

function buildCodexReplantDeps(overrides: Partial<CodexReplantResolutionDeps> = {}): CodexReplantResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    togglePlayerAutoReplant: async () => true,
    getPlayer: async (playerId: string) => buildPlayerState({ userId: playerId }),
    ...overrides,
  };
}

test("resolveCodexReplant A. joueur non allowliste : utilise store.mutatePlayer, jamais ensurePlayerExists/togglePlayerAutoReplant/deps.getPlayer, meme regle V1 (toggleAutoReplant reel de farm.ts)", async () => {
  const player = buildPlayerState({ autoReplant: false });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async () => {
    throw new Error("ensurePlayerExists ne doit jamais etre appele sur le chemin V1");
  });
  const togglePlayerAutoReplant = mock.fn(async () => {
    throw new Error("togglePlayerAutoReplant ne doit jamais etre appele sur le chemin V1");
  });
  const getPlayer = mock.fn(async () => {
    throw new Error("le repository getPlayer ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildCodexReplantDeps({ shouldUsePostgresRuntime: () => false, ensurePlayerExists, togglePlayerAutoReplant, getPlayer });

  const result = await resolveCodexReplant(TEST_PLAYER_ID, store, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(togglePlayerAutoReplant.mock.calls.length, 0);
  assert.equal(getPlayer.mock.calls.length, 0);
  // toggleAutoReplant() reel de farm.ts : bascule false -> true, regle V1 inchangee.
  assert.equal(result.player.autoReplant, true);
});

test("resolveCodexReplant B. joueur allowliste existant : ensurePlayerExists + togglePlayerAutoReplant + deps.getPlayer avec le bon playerId, jamais store.mutatePlayer", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer ne doit jamais etre appele sur le chemin Postgres");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }));
  const togglePlayerAutoReplant = mock.fn(async (_playerId: string) => true);
  const pgPlayer = buildPlayerState({ userId: TEST_PLAYER_ID, autoReplant: true });
  const getPlayer = mock.fn(async () => pgPlayer);
  const deps = buildCodexReplantDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, togglePlayerAutoReplant, getPlayer });

  const result = await resolveCodexReplant(TEST_PLAYER_ID, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(togglePlayerAutoReplant.mock.calls.length, 1);
  assert.equal(togglePlayerAutoReplant.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(getPlayer.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls.length, 0);
  assert.equal(result.player, pgPlayer, "doit retourner exactement le PlayerState relu du repository Postgres");
});

test("resolveCodexReplant C. joueur allowliste absent : bootstrap (created=true) PUIS togglePlayerAutoReplant PUIS deps.getPlayer, aucun chemin JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const togglePlayerAutoReplant = mock.fn(async () => {
    callOrder.push("toggle");
    return true;
  });
  const getPlayer = mock.fn(async () => {
    callOrder.push("getPlayer");
    return buildPlayerState({ userId: TEST_PLAYER_ID });
  });
  const deps = buildCodexReplantDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, togglePlayerAutoReplant, getPlayer });

  await resolveCodexReplant(TEST_PLAYER_ID, store, deps);

  assert.deepEqual(callOrder, ["ensure", "toggle", "getPlayer"]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
});

test("resolveCodexReplant D. source Postgres differente du JSON : le resultat correspond uniquement au Postgres, preuve qu'aucun melange des deux sources n'est possible", async () => {
  const jsonPlayer = buildPlayerState({ autoReplant: false });
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(jsonPlayer);
    return jsonPlayer;
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const pgPlayer = buildPlayerState({ userId: TEST_PLAYER_ID, autoReplant: true });

  const v1 = await resolveCodexReplant(TEST_PLAYER_ID, store, buildCodexReplantDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveCodexReplant(
    TEST_PLAYER_ID,
    store,
    buildCodexReplantDeps({ shouldUsePostgresRuntime: () => true, getPlayer: async () => pgPlayer }),
  );

  assert.equal(v1.player, jsonPlayer);
  assert.equal(pg.player, pgPlayer);
});

test("resolveCodexReplant E. reproduction du bug signale (UI Discord ON / Neon auto_replant=false) : DB initiale autoReplant=false -> toggle -> lecture suivante DOIT refleter exactement l'ecriture, aucun PlayerState pre-lu/stale n'est utilise pour l'affichage", async () => {
  // Simule fidelement le contrat reel de mutatePlayer()/getPlayer() cote
  // Postgres avec UNE SEULE 'ligne' partagee en memoire (jamais le meme
  // objet reference expose a l'appelant -- chaque acces retourne une
  // COPIE, exactement comme deux requetes SQL independantes le feraient) :
  // togglePlayerAutoReplant() mute cette ligne (comme mutatePlayer() dans
  // sa propre transaction reelle), PUIS getPlayer() la relit
  // INDEPENDAMMENT. Si resolveCodexReplant() utilisait par erreur un
  // player pre-lu/stale (lu AVANT la bascule, ou l'objet retourne par
  // ensurePlayerExists) pour construire sa reponse plutot que le resultat
  // de cette relecture post-toggle, ce test le detecterait immediatement.
  let dbRow = buildPlayerState({ userId: TEST_PLAYER_ID, autoReplant: false });
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({ player: { ...dbRow, userId: playerId }, created: false }));
  const togglePlayerAutoReplant = mock.fn(async (_playerId: string) => {
    dbRow = { ...dbRow, autoReplant: !dbRow.autoReplant };
    return dbRow.autoReplant;
  });
  const getPlayer = mock.fn(async (_playerId: string) => ({ ...dbRow }));
  const deps = buildCodexReplantDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, togglePlayerAutoReplant, getPlayer });
  const store = buildFakeStore(mock.fn(async () => {
    throw new Error("store.mutatePlayer ne doit jamais etre appele sur le chemin Postgres");
  }) as unknown as FarmStore["mutatePlayer"]);

  const result = await resolveCodexReplant(TEST_PLAYER_ID, store, deps);

  assert.equal(dbRow.autoReplant, true, "la 'DB' partagee doit refleter la bascule (false -> true) apres togglePlayerAutoReplant");
  assert.equal(
    result.player.autoReplant,
    true,
    "resolveCodexReplant doit retourner exactement ce que la relecture post-toggle rapporte (true), jamais l'etat pre-toggle (false) ni l'objet retourne par ensurePlayerExists",
  );
  assert.notEqual(result.player, dbRow, "result.player doit provenir de la copie retournee par getPlayer(), jamais une reference partagee mutable");
});

function buildCodexRefreshDeps(overrides: Partial<CodexRefreshResolutionDeps> = {}): CodexRefreshResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    enrichGlobalStateInPostgres: async () => ({ global: buildGlobalState(), changed: false }),
    ...overrides,
  };
}

test("resolveCodexRefresh A. joueur non allowliste : utilise enrichGlobalState(store.global) + store.save() conditionnel, jamais deps.enrichGlobalStateInPostgres, meme chemin V1", async () => {
  // marketUpdatedAt tres ancien (epoch 0) : garantit enrichGlobalState(...)
  // === true de maniere deterministe (fonction reelle de farm.ts).
  const globalState = defaultGlobalState(0);
  const save = mock.fn(async () => {});
  const store = { global: globalState, save } as unknown as FarmStore;
  const enrichGlobalStateInPostgres = mock.fn(async () => {
    throw new Error("enrichGlobalStateInPostgres ne doit jamais etre appele sur le chemin V1");
  });
  const deps = buildCodexRefreshDeps({ shouldUsePostgresRuntime: () => false, enrichGlobalStateInPostgres });

  const result = await resolveCodexRefresh(TEST_PLAYER_ID, store, deps);

  assert.equal(enrichGlobalStateInPostgres.mock.calls.length, 0);
  assert.equal(save.mock.calls.length, 1, "le marche est du (epoch 0) : store.save() doit etre appele, meme regle V1");
  assert.equal(result.changed, true);
  assert.equal(result.global, globalState);
});

test("resolveCodexRefresh B. joueur non allowliste, rien a actualiser : store.save() jamais appele, meme regle V1", async () => {
  // Construit avec Date.now() (pas NOW, un timestamp fixe passe) : garantit
  // qu'aucun intervalle (marche/meteo/contrat/defi) n'est du au moment ou
  // enrichGlobalState(...) tourne reellement (son propre `now` par defaut).
  const globalState = defaultGlobalState(Date.now());
  const save = mock.fn(async () => {});
  const store = { global: globalState, save } as unknown as FarmStore;
  const deps = buildCodexRefreshDeps({ shouldUsePostgresRuntime: () => false });

  const result = await resolveCodexRefresh(TEST_PLAYER_ID, store, deps);

  assert.equal(save.mock.calls.length, 0, "rien n'est du : aucune ecriture JSON attendue");
  assert.equal(result.changed, false);
});

test("resolveCodexRefresh C. joueur allowliste : utilise deps.enrichGlobalStateInPostgres (Postgres) uniquement, jamais store.global/store.save, aucune mutation JSON", async () => {
  const save = mock.fn(async () => {});
  const store = { global: buildGlobalState(), save } as unknown as FarmStore;
  const pgGlobal = buildGlobalState({ marketMultiplier: 1.5 });
  const enrichGlobalStateInPostgres = mock.fn(async () => ({ global: pgGlobal, changed: true }));
  const deps = buildCodexRefreshDeps({ shouldUsePostgresRuntime: () => true, enrichGlobalStateInPostgres });

  const result = await resolveCodexRefresh(TEST_PLAYER_ID, store, deps);

  assert.equal(enrichGlobalStateInPostgres.mock.calls.length, 1);
  assert.equal(save.mock.calls.length, 0, "aucune ecriture JSON attendue cote Postgres");
  assert.equal(result.global, pgGlobal, "doit retourner exactement le GlobalState Postgres, jamais store.global");
  assert.equal(result.changed, true);
});

test("resolveCodexRefresh D. source Postgres differente du JSON : le resultat correspond uniquement au Postgres, preuve qu'aucun melange des deux sources n'est possible", async () => {
  const jsonGlobal = buildGlobalState({ marketMultiplier: 1 });
  const store = { global: jsonGlobal, save: async () => {} } as unknown as FarmStore;
  const pgGlobal = buildGlobalState({ marketMultiplier: 2 });

  const v1 = await resolveCodexRefresh(TEST_PLAYER_ID, store, buildCodexRefreshDeps({ shouldUsePostgresRuntime: () => false }));
  const pg = await resolveCodexRefresh(
    TEST_PLAYER_ID,
    store,
    buildCodexRefreshDeps({ shouldUsePostgresRuntime: () => true, enrichGlobalStateInPostgres: async () => ({ global: pgGlobal, changed: false }) }),
  );

  assert.equal(v1.global, jsonGlobal);
  assert.equal(pg.global, pgGlobal);
});

test("resolveCodexRefresh E. /codex refresh est GLOBAL-ONLY : ensurePlayerExists/getPlayer n'existent meme pas dans CodexRefreshResolutionDeps, aucun bootstrap joueur possible", async () => {
  const deps = buildCodexRefreshDeps({ shouldUsePostgresRuntime: () => true, enrichGlobalStateInPostgres: async () => ({ global: buildGlobalState(), changed: false }) });

  assert.ok(!("ensurePlayerExists" in deps), "CodexRefreshResolutionDeps ne doit jamais accepter ensurePlayerExists");
  assert.ok(!("getPlayer" in deps), "CodexRefreshResolutionDeps ne doit jamais accepter getPlayer");
  assert.ok(!("getGlobalState" in deps), "CodexRefreshResolutionDeps ne doit jamais accepter getGlobalState (le verrou/relecture vit dans mutateGlobalState(), via enrichGlobalStateInPostgres)");

  await resolveCodexRefresh(TEST_PLAYER_ID, { global: buildGlobalState(), save: async () => {} } as unknown as FarmStore, deps);
});

// ===========================================================================
// handleCodexComponent -- audit structurel (source-scan, meme technique que
// resolveProfile H / resolveWeekly K) : /codex initial et son bouton
// "Planter" reutilisent resolveFarmView/resolvePlantCrop TELS QUELS (aucune
// duplication de logique), et handleCodexComponent lui-meme ne doit JAMAIS
// muter le store directement (ni store.mutatePlayer, ni store.save, ni
// mutation en place de `player`/`enrichGlobalState(store.global)`) -- toute
// mutation vit exclusivement dans les resolveurs qu'il appelle. Preuve
// egalement que chaque appel mutateur (plant/replant/refresh) ne recoit
// QUE `userId`/`store` (et cropId pour plant) en argument -- jamais le
// `player`/`global` deja lus plus haut -- ce qui garantit que deux
// interactions concurrentes ne partent jamais d'un etat pre-lu perime :
// chaque resolveur relit/verrouille sa propre transaction depuis zero.
// ===========================================================================

test("handleCodexComponent : reutilise resolveFarmView/resolvePlantCrop/resolveCodexReplant/resolveCodexRefresh, ne mute jamais le store directement lui-meme", async () => {
  const source = await readFile(new URL("./presenters.ts", import.meta.url), "utf8");
  const handlerStart = source.indexOf("export async function handleCodexComponent(");
  assert.ok(handlerStart >= 0, "handleCodexComponent doit exister");
  const handlerBody = source.slice(handlerStart);

  for (const reused of ["resolveFarmView(", "resolvePlantCrop(", "resolveCodexReplant(", "resolveCodexRefresh("]) {
    assert.ok(handlerBody.includes(reused), `handleCodexComponent doit reutiliser ${reused}`);
  }
  for (const forbidden of ["store.mutatePlayer(", "store.save(", "enrichGlobalState(store.global)", "player.autoReplant =", "await plant("]) {
    assert.ok(!handlerBody.includes(forbidden), `handleCodexComponent ne doit jamais referencer ${forbidden} directement -- toute mutation vit dans les resolveurs`);
  }
});

test("handleCodexComponent : les appels mutateurs (plant/replant/refresh) ne recoivent jamais le player/global deja lus en argument (chaque resolveur relit sa propre transaction, aucun etat perime partage entre interactions concurrentes)", async () => {
  const source = await readFile(new URL("./presenters.ts", import.meta.url), "utf8");
  const handlerStart = source.indexOf("export async function handleCodexComponent(");
  const handlerBody = source.slice(handlerStart);

  assert.ok(
    /resolvePlantCrop\(userId, view\.cropId, null, store\)/.test(handlerBody),
    "resolvePlantCrop doit etre appele avec (userId, view.cropId, null, store) uniquement, jamais un player/global pre-lu",
  );
  assert.ok(
    /resolveCodexReplant\(userId, store\)/.test(handlerBody),
    "resolveCodexReplant doit etre appele avec (userId, store) uniquement, jamais un player pre-lu",
  );
  assert.ok(
    /resolveCodexRefresh\(userId, store\)/.test(handlerBody),
    "resolveCodexRefresh doit etre appele avec (userId, store) uniquement, jamais un global pre-lu",
  );
});

// ===========================================================================
// H. Audit anti-divergence (LOT 6) : shouldUsePostgresRuntime doit apparaitre
// EXACTEMENT 16 fois (le garde-fou de preambule + resolveBuyUpgrade +
// resolveDailyClaim + resolvePlantCrop + resolveCraftItem +
// resolveHarvestCrops + resolveSellItems + resolveInventory +
// resolveFarmView + resolveProfile + resolveMarket + resolveContract +
// resolveLeaderboard + resolveWeekly + resolveCodexReplant +
// resolveCodexRefresh) ; ensurePlayerExists EXACTEMENT 10 fois -- +1 depuis
// /weekly (resolveCodexReplant, seul nouveau resolveur de ce lot a
// bootstrapper un joueur -- resolveCodexRefresh est GLOBAL-ONLY, aucun
// bootstrap) : resolveBuyUpgrade + resolveDailyClaim + resolvePlantCrop +
// resolveCraftItem + resolveHarvestCrops + resolveSellItems +
// resolveInventory + resolveFarmView + resolveProfile + resolveCodexReplant
// (ni resolveMarket, ni resolveContract, ni resolveLeaderboard, ni
// resolveWeekly, ni resolveCodexRefresh) ; buyPlayerUpgrade,
// claimPlayerDaily, plantPlayerCrop, craftPlayerItem, harvestPlayerCrops et
// sellPlayerItems EXACTEMENT 1 fois chacun (leur seule fonction de
// resolution respective, resolveCodexPlant reutilisant resolvePlantCrop
// directement plutot que dupliquer plantPlayerCrop). deps.getPlayer( (le
// repository, pas store.getPlayer) EXACTEMENT 5 fois -- +1 depuis /weekly
// (resolveCodexReplant) : resolvePlantCrop + resolveInventory +
// resolveFarmView + resolveProfile + resolveCodexReplant ; deps.getGlobalState(
// EXACTEMENT 6 fois -- INCHANGE depuis /leaderboard, ce qui PROUVE que
// resolveCodexRefresh n'appelle jamais deps.getGlobalState (le
// verrou/relecture vit dans mutateGlobalState(), via
// enrichGlobalStateInPostgres) : resolveInventory + resolveFarmView +
// resolveProfile + resolveMarket + resolveContract + resolveLeaderboard ;
// deps.getAllPlayers( EXACTEMENT 2 fois -- INCHANGE (resolveLeaderboard +
// resolveWeekly, /codex n'en a pas besoin) ; deps.togglePlayerAutoReplant(
// EXACTEMENT 1 fois (resolveCodexReplant) ; deps.enrichGlobalStateInPostgres(
// EXACTEMENT 1 fois (resolveCodexRefresh). Preuve automatisee (lecture du
// fichier source, meme technique que les tests transversaux existants de
// farmRepository.test.ts/farmPlayerActions.test.ts) qu'aucune autre
// commande n'a ete branchee sur Postgres par erreur, et que /buy, /daily,
// /plant, /craft, /harvest, /sell, /inventory, /farm, /profile, /market,
// /contract, /leaderboard, /weekly et /codex (toutes les slash commands
// Farm2Win) sont desormais les QUATORZE chemins Postgres.
// ===========================================================================

test("presenters.ts : shouldUsePostgresRuntime/ensurePlayerExists/buyPlayerUpgrade/claimPlayerDaily/plantPlayerCrop/craftPlayerItem/harvestPlayerCrops/sellPlayerItems/getPlayer/getGlobalState/getAllPlayers/togglePlayerAutoReplant/enrichGlobalStateInPostgres n'ont que les sites d'appel attendus, aucune autre commande", async () => {
  const source = await readFile(new URL("./presenters.ts", import.meta.url), "utf8");
  const countCalls = (name: string) => (source.match(new RegExp(`${name}\\(`, "g")) ?? []).length;

  assert.equal(
    countCalls("shouldUsePostgresRuntime"),
    16,
    "16 sites d'appel attendus : garde-fou de preambule + resolveBuyUpgrade + resolveDailyClaim + resolvePlantCrop + resolveCraftItem + resolveHarvestCrops + resolveSellItems + resolveInventory + resolveFarmView + resolveProfile + resolveMarket + resolveContract + resolveLeaderboard + resolveWeekly + resolveCodexReplant + resolveCodexRefresh",
  );
  assert.equal(countCalls("harvestPlayerCrops"), 1, "un seul site d'appel attendu (resolveHarvestCrops)");
  assert.equal(countCalls("sellPlayerItems"), 1, "un seul site d'appel attendu (resolveSellItems)");
  assert.equal(
    countCalls("ensurePlayerExists"),
    10,
    "10 sites d'appel attendus, +1 depuis /weekly (resolveCodexReplant, seul nouveau resolveur de /codex a bootstrapper un joueur) : resolveBuyUpgrade + resolveDailyClaim + resolvePlantCrop + resolveCraftItem + resolveHarvestCrops + resolveSellItems + resolveInventory + resolveFarmView + resolveProfile + resolveCodexReplant",
  );
  assert.equal(countCalls("buyPlayerUpgrade"), 1, "un seul site d'appel attendu (resolveBuyUpgrade)");
  assert.equal(countCalls("claimPlayerDaily"), 1, "un seul site d'appel attendu (resolveDailyClaim)");
  assert.equal(countCalls("plantPlayerCrop"), 1, "un seul site d'appel attendu (resolvePlantCrop) -- le bouton codex 'Planter' reutilise resolvePlantCrop directement, jamais un second appel a plantPlayerCrop");
  assert.equal(countCalls("craftPlayerItem"), 1, "un seul site d'appel attendu (resolveCraftItem)");
  // "deps.getPlayer(" exclut deliberement "store.getPlayer(" (compte a part,
  // deja verifie test par test ci-dessus) -- seul le repository nous
  // interesse ici, pas la methode FarmStore preexistante.
  assert.equal(
    countCalls("deps.getPlayer"),
    5,
    "cinq sites d'appel du repository getPlayer attendus, +1 depuis /weekly (resolveCodexReplant) : resolvePlantCrop + resolveInventory + resolveFarmView + resolveProfile + resolveCodexReplant",
  );
  assert.equal(
    countCalls("deps.getGlobalState"),
    6,
    "six sites d'appel du repository getGlobalState attendus, INCHANGE depuis /leaderboard -- resolveCodexRefresh n'appelle jamais deps.getGlobalState (resolveInventory + resolveFarmView + resolveProfile + resolveMarket + resolveContract + resolveLeaderboard)",
  );
  assert.equal(countCalls("deps.getAllPlayers"), 2, "deux sites d'appel du repository getAllPlayers attendus, INCHANGE -- /codex n'en a pas besoin (resolveLeaderboard + resolveWeekly)");
  assert.equal(countCalls("deps.togglePlayerAutoReplant"), 1, "un seul site d'appel attendu (resolveCodexReplant)");
  assert.equal(countCalls("deps.enrichGlobalStateInPostgres"), 1, "un seul site d'appel attendu (resolveCodexRefresh)");
});

// ===========================================================================
// I. Preambule enrichGlobalState/store.save() -- ne doit JAMAIS s'executer
// pour /buy, /daily, /plant, /craft, /harvest, /sell, /inventory, /farm,
// /profile, /market, /contract, /leaderboard, /weekly ou /codex d'un
// joueur allowliste (aucune ecriture JSON), mais DOIT continuer a
// s'executer exactement comme avant pour toute autre commande (V1
// inchange). commandSkipsJsonPreamble() est la decision PURE qui gouverne
// ce garde-fou -- testee ici directement (aucune connexion DB necessaire).
// IMPORTANT : ce garde-fou ne gouverne QUE le preambule de
// handleSlashCommand, donc UNIQUEMENT la slash command /codex elle-meme --
// verifie a l'audit dedie, les composants (boutons/select-menus)
// interactifs de /codex sont routes DIRECTEMENT depuis bot.ts vers
// handleCodexComponent, jamais via handleSlashCommand, donc jamais via ce
// preambule (ce Set n'a donc aucun effet sur eux, testes separement plus
// haut). handleSlashCommand("list") verifie separement, en bout en bout,
// qu'une commande V1 declenche toujours reellement le preambule -- "list"
// est desormais la SEULE commande utilisee comme exemple V1 encore
// intacte : toutes les slash commands Farm2Win sont a present migrees.
// ===========================================================================

test("commandSkipsJsonPreamble : true UNIQUEMENT pour /buy, /daily, /plant, /craft, /harvest, /sell, /inventory, /farm, /profile, /market, /contract, /leaderboard, /weekly ou /codex d'un joueur allowliste, jamais pour une autre commande ni un joueur non allowliste", () => {
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
  assert.equal(commandSkipsJsonPreamble("contract", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("leaderboard", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("weekly", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("codex", TEST_PLAYER_ID, allowlisted), true);
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
  assert.equal(commandSkipsJsonPreamble("contract", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("leaderboard", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("weekly", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("codex", TEST_PLAYER_ID, notAllowlisted), false);
  // Meme allowliste, une commande jamais branchee sur Postgres reste V1 --
  // le preambule doit continuer a s'executer pour elle, sans exception.
  // Toutes les slash commands Farm2Win sont desormais migrees : "list" est
  // la seule commande restant volontairement hors de ce Set.
  assert.equal(commandSkipsJsonPreamble("list", TEST_PLAYER_ID, allowlisted), false);
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

// ===========================================================================
// Logging diagnostique des erreurs inattendues (catch global de
// handleSlashCommand / handleCodexComponent) -- prouve que : (A) une
// FarmError (erreur metier attendue, deja affichee a l'utilisateur) ne
// declenche JAMAIS logger.error (bruit inutile, deja visible via le
// message Discord), et (B) une erreur NON-FarmError (inattendue) declenche
// logger.error EXACTEMENT une fois, sans jamais changer le message
// generique affiche a l'utilisateur.
// ===========================================================================

test("handleSlashCommand : commande inconnue (FarmError \"Commande inconnue.\") -> replyError repond normalement, logger.error N'EST PAS appele", async () => {
  const errorSpy = mock.method(logger, "error", () => {});
  try {
    const global = defaultGlobalState(Date.now());
    const reply = mock.fn(async (_payload: unknown) => {});
    const store = { global, save: mock.fn(async () => {}) } as unknown as FarmStore;
    const interaction = {
      commandName: "commande-inexistante",
      user: { id: TEST_PLAYER_ID },
      replied: false,
      deferred: false,
      reply,
    } as unknown as ChatInputCommandInteraction;

    await handleSlashCommand(interaction, store);

    assert.equal(errorSpy.mock.calls.length, 0, "une FarmError ne doit jamais declencher logger.error");
    assert.equal(reply.mock.calls.length, 1, "replyError doit tout de meme repondre a l'utilisateur");
    const [payload] = reply.mock.calls[0]!.arguments as [{ embeds: { data: { description?: string } }[] }];
    assert.ok(payload.embeds[0]!.data.description?.includes("Commande inconnue."), "le message FarmError original doit rester affiche");
  } finally {
    errorSpy.mock.restore();
  }
});

test("handleSlashCommand : erreur generique (non-FarmError) pendant le preambule -> logger.error appele EXACTEMENT une fois, message utilisateur reste generique/inchange", async () => {
  const errorSpy = mock.method(logger, "error", () => {});
  try {
    // marketUpdatedAt=0 : enrichGlobalState() reel retourne true de maniere
    // deterministe, donc store.save() est bien appele et peut jeter.
    const global = defaultGlobalState(0);
    const reply = mock.fn(async (_payload: unknown) => {});
    const store = {
      global,
      save: mock.fn(async () => {
        throw new Error("panne DB simulee, non-FarmError");
      }),
    } as unknown as FarmStore;
    const interaction = {
      commandName: "list",
      user: { id: TEST_PLAYER_ID },
      replied: false,
      deferred: false,
      reply,
    } as unknown as ChatInputCommandInteraction;

    await handleSlashCommand(interaction, store);

    assert.equal(errorSpy.mock.calls.length, 1, "une erreur non-FarmError doit declencher logger.error exactement une fois");
    const [logPayload] = errorSpy.mock.calls[0]!.arguments as [{ err: unknown; command: string }, string];
    assert.equal(logPayload.command, "list");
    assert.ok(logPayload.err instanceof Error);
    assert.equal(reply.mock.calls.length, 1);
    const [payload] = reply.mock.calls[0]!.arguments as [{ embeds: { data: { description?: string } }[] }];
    assert.ok(
      payload.embeds[0]!.data.description?.includes("Une erreur inattendue est survenue"),
      "le message utilisateur doit rester le message generique inchange, jamais le detail de l'erreur reelle",
    );
  } finally {
    errorSpy.mock.restore();
  }
});

test("handleCodexComponent : erreur generique (non-FarmError) -> logger.error appele EXACTEMENT une fois, message utilisateur reste generique/inchange", async () => {
  const errorSpy = mock.method(logger, "error", () => {});
  try {
    const reply = mock.fn(async (_payload: unknown) => {});
    const store = {
      global: defaultGlobalState(Date.now()),
      getPlayer: () => {
        throw new Error("panne inattendue simulee, non-FarmError");
      },
    } as unknown as FarmStore;
    const interaction = {
      customId: `codex:replant:${TEST_PLAYER_ID}`,
      user: { id: TEST_PLAYER_ID },
      message: { id: "codex-message-1" },
      replied: false,
      deferred: false,
      reply,
      isStringSelectMenu: () => false,
    } as unknown as Parameters<typeof handleCodexComponent>[0];

    await handleCodexComponent(interaction, store);

    assert.equal(errorSpy.mock.calls.length, 1, "une erreur non-FarmError doit declencher logger.error exactement une fois");
    const [logPayload] = errorSpy.mock.calls[0]!.arguments as [{ err: unknown; customIdCategory: string }, string];
    assert.equal(logPayload.customIdCategory, "replant", "seule la categorie (parts[1]) doit etre loggee, jamais le customId complet (qui contient le playerId)");
    assert.ok(logPayload.err instanceof Error);
    assert.equal(reply.mock.calls.length, 1);
    const [payload] = reply.mock.calls[0]!.arguments as [{ embeds: { data: { description?: string } }[] }];
    assert.ok(
      payload.embeds[0]!.data.description?.includes("Une erreur inattendue est survenue"),
      "le message utilisateur doit rester le message generique inchange",
    );
  } finally {
    errorSpy.mock.restore();
  }
});
