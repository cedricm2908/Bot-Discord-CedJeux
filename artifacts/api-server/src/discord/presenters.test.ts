// Tests de presenters.ts -- LOT 6, UNIQUEMENT le branchement PostgreSQL de
// /buy (resolveBuyUpgrade), /daily (resolveDailyClaim), /plant
// (resolvePlantCrop), /craft (resolveCraftItem) et /harvest
// (resolveHarvestCrops), plus le garde-fou de preambule
// (commandSkipsJsonPreamble). N'importe jamais discord.js comme valeur
// d'execution pour les tests resolveBuyUpgrade/resolveDailyClaim/
// resolvePlantCrop/resolveCraftItem/resolveHarvestCrops (ni fausse
// ChatInputCommandInteraction) : ces fonctions ont ete extraites de
// commandBuy()/commandDaily()/commandPlant()/commandCraft()/commandHarvest()
// precisement pour rester testables ainsi -- seule la DECISION (V1 vs
// Postgres, quel resultat) est exercee ici. Le parsing des options et la
// construction de l'embed Discord restent dans ces command*(), inchanges,
// non couverts par ce fichier (aucune regle metier n'y est ajoutee ni
// testee a nouveau). Une fausse interaction minimale N'EST construite QUE
// pour le test "list" de handleSlashCommand (commande sans donnee joueur,
// jamais de connexion DB).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import { FarmError, growMinutes } from "./farm.ts";
import type { ChatInputCommandInteraction } from "discord.js";
import {
  commandSkipsJsonPreamble,
  handleSlashCommand,
  resolveBuyUpgrade,
  resolveCraftItem,
  resolveDailyClaim,
  resolveHarvestCrops,
  resolvePlantCrop,
  type BuyResolutionDeps,
  type CraftResolutionDeps,
  type DailyResolutionDeps,
  type HarvestResolutionDeps,
  type PlantResolutionDeps,
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
// H. Audit anti-divergence (LOT 6) : shouldUsePostgresRuntime doit apparaitre
// EXACTEMENT 6 fois (le garde-fou de preambule + resolveBuyUpgrade +
// resolveDailyClaim + resolvePlantCrop + resolveCraftItem +
// resolveHarvestCrops) ; ensurePlayerExists EXACTEMENT 5 fois
// (resolveBuyUpgrade + resolveDailyClaim + resolvePlantCrop + resolveCraftItem
// + resolveHarvestCrops) ; buyPlayerUpgrade, claimPlayerDaily, plantPlayerCrop,
// craftPlayerItem et harvestPlayerCrops EXACTEMENT 1 fois chacun (leur seule
// fonction de resolution respective). getPlayer( (le repository, pas
// store.getPlayer) EXACTEMENT 1 fois (resolvePlantCrop). Preuve automatisee
// (lecture du fichier source, meme technique que les tests transversaux
// existants de farmRepository.test.ts/farmPlayerActions.test.ts) qu'aucune
// autre commande (/sell, /market, etc.) n'a ete branchee sur Postgres par
// erreur, et que /buy, /daily, /plant, /craft et /harvest sont desormais
// les CINQ SEULS chemins Postgres.
// ===========================================================================

test("presenters.ts : shouldUsePostgresRuntime/ensurePlayerExists/buyPlayerUpgrade/claimPlayerDaily/plantPlayerCrop/craftPlayerItem/harvestPlayerCrops/getPlayer n'ont que les sites d'appel attendus, aucune autre commande", async () => {
  const source = await readFile(new URL("./presenters.ts", import.meta.url), "utf8");
  const countCalls = (name: string) => (source.match(new RegExp(`${name}\\(`, "g")) ?? []).length;

  assert.equal(
    countCalls("shouldUsePostgresRuntime"),
    6,
    "6 sites d'appel attendus : garde-fou de preambule + resolveBuyUpgrade + resolveDailyClaim + resolvePlantCrop + resolveCraftItem + resolveHarvestCrops",
  );
  assert.equal(countCalls("harvestPlayerCrops"), 1, "un seul site d'appel attendu (resolveHarvestCrops)");
  assert.equal(
    countCalls("ensurePlayerExists"),
    5,
    "5 sites d'appel attendus : resolveBuyUpgrade + resolveDailyClaim + resolvePlantCrop + resolveCraftItem + resolveHarvestCrops",
  );
  assert.equal(countCalls("buyPlayerUpgrade"), 1, "un seul site d'appel attendu (resolveBuyUpgrade)");
  assert.equal(countCalls("claimPlayerDaily"), 1, "un seul site d'appel attendu (resolveDailyClaim)");
  assert.equal(countCalls("plantPlayerCrop"), 1, "un seul site d'appel attendu (resolvePlantCrop)");
  assert.equal(countCalls("craftPlayerItem"), 1, "un seul site d'appel attendu (resolveCraftItem)");
  // "deps.getPlayer(" exclut deliberement "store.getPlayer(" (compte a part,
  // deja verifie test par test ci-dessus) -- seul le repository nous
  // interesse ici, pas la methode FarmStore preexistante.
  assert.equal(countCalls("deps.getPlayer"), 1, "un seul site d'appel du repository getPlayer attendu (resolvePlantCrop)");
});

// ===========================================================================
// I. Preambule enrichGlobalState/store.save() -- ne doit JAMAIS s'executer
// pour /buy, /daily, /plant, /craft ou /harvest d'un joueur allowliste
// (aucune ecriture JSON), mais DOIT continuer a s'executer exactement
// comme avant pour toute autre commande (V1 inchange). commandSkipsJsonPreamble()
// est la decision PURE qui gouverne ce garde-fou -- testee ici directement
// (aucune connexion DB necessaire). handleSlashCommand("list") verifie
// separement, en bout en bout, qu'une commande V1 declenche toujours
// reellement le preambule.
// ===========================================================================

test("commandSkipsJsonPreamble : true UNIQUEMENT pour /buy, /daily, /plant, /craft ou /harvest d'un joueur allowliste, jamais pour une autre commande ni un joueur non allowliste", () => {
  const allowlisted = { shouldUsePostgresRuntime: () => true };
  const notAllowlisted = { shouldUsePostgresRuntime: () => false };

  assert.equal(commandSkipsJsonPreamble("buy", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("daily", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("plant", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("craft", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("harvest", TEST_PLAYER_ID, allowlisted), true);
  assert.equal(commandSkipsJsonPreamble("buy", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("daily", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("plant", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("craft", TEST_PLAYER_ID, notAllowlisted), false);
  assert.equal(commandSkipsJsonPreamble("harvest", TEST_PLAYER_ID, notAllowlisted), false);
  // Meme allowliste, une commande jamais branchee sur Postgres reste V1 --
  // le preambule doit continuer a s'executer pour elle, sans exception.
  assert.equal(commandSkipsJsonPreamble("farm", TEST_PLAYER_ID, allowlisted), false);
  assert.equal(commandSkipsJsonPreamble("profile", TEST_PLAYER_ID, allowlisted), false);
  assert.equal(commandSkipsJsonPreamble("sell", TEST_PLAYER_ID, allowlisted), false);
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
