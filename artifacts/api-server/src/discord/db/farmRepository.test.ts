// Tests de farmRepository.ts (lecture ET ecriture). Aucune connexion
// PostgreSQL : ces tests n'importent jamais @workspace/db ou
// @workspace/db/repositories comme valeur d'execution -- uniquement des DTO
// construits en memoire et des dependances mockees (PlayerWriteDeps pour
// l'ecriture, FarmRepositoryDeps pour la lecture). Les adaptateurs REELS
// (toPlayerState/toGlobalState) sont utilises tels quels pour prouver
// l'integration bout en bout, sans jamais toucher @workspace/db.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import type { GlobalStateRecord, PlayerRecord } from "@workspace/db/repositories";
import type {
  ContractRow,
  DailyChallengeContributor,
  DailyChallengeRow,
  GlobalStateRow,
  InventoryItem as InventoryItemRow,
  Player,
  Plot as PlotRow,
} from "@workspace/db";
import {
  createFarmRepository,
  mutateGlobalState,
  mutatePlayer,
  mutatePlayerAndGlobal,
  savePlayer,
  savePlayerWithTx,
  type FarmRepositoryDeps,
  type MutateGlobalStateDeps,
  type MutatePlayerAndGlobalDeps,
  type MutatePlayerDeps,
  type PlayerWriteDeps,
} from "./farmRepository.ts";
import { toGlobalState } from "./globalStateAdapter.ts";
import { toPlayerState } from "./playerAdapter.ts";
import type { GlobalState, PlayerState } from "../types";

const NOW = new Date(1_700_000_000_000);
const TEST_PLAYER_ID = "v2-test-player-001";

function buildPlayerRecord(id: string): PlayerRecord {
  return {
    player: {
      id,
      coins: 50,
      level: 1,
      xp: 0,
      irrigationLevel: 0,
      fertilizerLevel: 0,
      lastDailyAt: null,
      autoReplant: false,
      weeklySnapshotCoins: 50,
      totalHarvested: 0,
      quests: [],
      questsResetAt: NOW,
      plotSkin: "classic",
      unlockedSkins: ["classic"],
      weatherForecast: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    plots: [],
    inventoryItems: [],
  };
}

function buildGlobalStateRecord(): GlobalStateRecord {
  return {
    globalState: {
      id: 1,
      marketMultiplier: 1,
      previousMarketMultiplier: 1,
      marketUpdatedAt: NOW,
      weather: "normal",
      weatherMultiplier: 1,
      weatherChangedAt: null,
      weatherExpiresAt: null,
      nextWeatherAt: NOW,
      nextWeatherType: "rain",
      weeklyStartedAt: NOW,
    },
    contract: {
      id: 1,
      cropId: "wheat",
      required: 20,
      remaining: 20,
      bonusMultiplier: 1.6,
      renewedAt: NOW,
    },
    dailyChallenge: {
      id: 1,
      cropId: "wheat",
      target: 200,
      progress: 0,
      rewardCoins: 80,
      startedAt: NOW,
      completed: false,
      rewarded: false,
    },
    dailyChallengeContributors: [],
  };
}

function buildDeps(overrides: Partial<FarmRepositoryDeps> = {}): FarmRepositoryDeps {
  return {
    getPlayerRecord: async () => null,
    getAllPlayerRecords: async () => [],
    getGlobalStateRecord: async () => null,
    toPlayerState,
    toGlobalState,
    ...overrides,
  };
}

test("getPlayer : joueur trouve -> PlayerState via toPlayerState", async () => {
  const record = buildPlayerRecord("p1");
  const repo = createFarmRepository(buildDeps({ getPlayerRecord: async (id) => (id === "p1" ? record : null) }));
  const state = await repo.getPlayer("p1");
  assert.deepEqual(state, toPlayerState(record));
  assert.equal(state?.userId, "p1");
});

test("getPlayer : joueur absent -> null", async () => {
  const repo = createFarmRepository(buildDeps({ getPlayerRecord: async () => null }));
  const state = await repo.getPlayer("inconnu");
  assert.equal(state, null);
});

test("getAllPlayers : plusieurs joueurs -> PlayerState[]", async () => {
  const r1 = buildPlayerRecord("p1");
  const r2 = buildPlayerRecord("p2");
  const repo = createFarmRepository(buildDeps({ getAllPlayerRecords: async () => [r1, r2] }));
  const states = await repo.getAllPlayers();
  assert.equal(states.length, 2);
  assert.deepEqual(states.map((s) => s.userId), ["p1", "p2"]);
  assert.deepEqual(states, [toPlayerState(r1), toPlayerState(r2)]);
});

test("getAllPlayers : aucun joueur -> tableau vide", async () => {
  const repo = createFarmRepository(buildDeps({ getAllPlayerRecords: async () => [] }));
  const states = await repo.getAllPlayers();
  assert.deepEqual(states, []);
});

test("getGlobalState : present -> GlobalState via toGlobalState", async () => {
  const record = buildGlobalStateRecord();
  const repo = createFarmRepository(buildDeps({ getGlobalStateRecord: async () => record }));
  const state = await repo.getGlobalState();
  assert.deepEqual(state, toGlobalState(record));
});

test("getGlobalState : absent -> null", async () => {
  const repo = createFarmRepository(buildDeps({ getGlobalStateRecord: async () => null }));
  const state = await repo.getGlobalState();
  assert.equal(state, null);
});

test("getPlayer : l'adaptateur injecte est reellement appele avec le PlayerRecord recu (pas contourne)", async () => {
  const record = buildPlayerRecord("p1");
  const toPlayerStateSpy = mock.fn((r: PlayerRecord) => toPlayerState(r));
  const repo = createFarmRepository(
    buildDeps({ getPlayerRecord: async () => record, toPlayerState: toPlayerStateSpy }),
  );
  await repo.getPlayer("p1");
  assert.equal(toPlayerStateSpy.mock.calls.length, 1);
  assert.deepEqual(toPlayerStateSpy.mock.calls[0]?.arguments, [record]);
});

test("getGlobalState : l'adaptateur injecte est reellement appele avec le GlobalStateRecord recu (pas contourne)", async () => {
  const record = buildGlobalStateRecord();
  const toGlobalStateSpy = mock.fn((r: GlobalStateRecord) => toGlobalState(r));
  const repo = createFarmRepository(
    buildDeps({ getGlobalStateRecord: async () => record, toGlobalState: toGlobalStateSpy }),
  );
  await repo.getGlobalState();
  assert.equal(toGlobalStateSpy.mock.calls.length, 1);
  assert.deepEqual(toGlobalStateSpy.mock.calls[0]?.arguments, [record]);
});

test("getAllPlayers : l'adaptateur injecte est appele une fois par enregistrement", async () => {
  const r1 = buildPlayerRecord("p1");
  const r2 = buildPlayerRecord("p2");
  const toPlayerStateSpy = mock.fn((r: PlayerRecord) => toPlayerState(r));
  const repo = createFarmRepository(
    buildDeps({ getAllPlayerRecords: async () => [r1, r2], toPlayerState: toPlayerStateSpy }),
  );
  await repo.getAllPlayers();
  assert.equal(toPlayerStateSpy.mock.calls.length, 2);
});

// ===========================================================================
// savePlayerWithTx / savePlayer -- ECRITURE, mocks/fakes uniquement, jamais
// de vraie base. `tx` est une valeur factice non structurellement typee (les
// vraies operations Drizzle passent par PlayerWriteDeps mocke, jamais par tx
// directement dans ces tests -- sauf le test dedie "aucun DELETE" qui
// exerce les implementations reelles contre un faux tx).
// ===========================================================================

const FAKE_TX = { marker: "fake-tx" } as never;

function buildPlayerRow(id: string): Player {
  // savePlayerWithTx ne lit jamais les champs de la ligne retournee par
  // lockAndGetPlayer -- seule sa presence/absence compte. Cast minimal
  // volontaire pour ce fixture de test.
  return { id } as Player;
}

function buildPlayerState(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    userId: id,
    coins: 75,
    level: 2,
    xp: 10,
    plots: [
      { cropId: null, plantedAt: null, notifiedReady: false },
      { cropId: "wheat", plantedAt: 1_700_050_000_000, notifiedReady: true },
    ],
    inventory: { wheat: 5, carrot: 0 },
    irrigationLevel: 1,
    fertilizerLevel: 0,
    lastDailyAt: 1_700_000_000_000,
    autoReplant: true,
    weeklySnapshotCoins: 50,
    createdAt: 1_699_000_000_000,
    updatedAt: 1_700_200_000_000,
    totalHarvested: 12,
    quests: [
      { type: "harvest", label: "Recolter 10 cultures", target: 10, progress: 3, rewardCoins: 40, claimed: false },
    ],
    questsResetAt: 1_700_100_000_000,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: "rain",
    ...overrides,
  };
}

function buildWriteDeps(overrides: Partial<PlayerWriteDeps> = {}): PlayerWriteDeps {
  return {
    lockAndGetPlayer: async (_tx, id) => buildPlayerRow(id),
    updatePlayerRow: async () => {},
    upsertPlots: async () => {},
    upsertInventoryItems: async () => {},
    ...overrides,
  };
}

test("1. joueur existant : tous les champs scalaires sont correctement transmis a updatePlayerRow", async () => {
  const state = buildPlayerState(TEST_PLAYER_ID);
  const updatePlayerRow = mock.fn(async (..._args: Parameters<PlayerWriteDeps["updatePlayerRow"]>) => {});
  await savePlayerWithTx(FAKE_TX, state, buildWriteDeps({ updatePlayerRow }));

  assert.equal(updatePlayerRow.mock.calls.length, 1);
  const [, calledId, values] = updatePlayerRow.mock.calls[0]!.arguments;
  assert.equal(calledId, TEST_PLAYER_ID);
  assert.equal(values.coins, 75);
  assert.equal(values.level, 2);
  assert.equal(values.xp, 10);
  assert.equal(values.irrigationLevel, 1);
  assert.equal(values.fertilizerLevel, 0);
  assert.deepEqual(values.lastDailyAt, new Date(1_700_000_000_000));
  assert.equal(values.autoReplant, true);
  assert.equal(values.weeklySnapshotCoins, 50);
  assert.equal(values.totalHarvested, 12);
  assert.deepEqual(values.quests, state.quests);
  assert.deepEqual(values.questsResetAt, new Date(1_700_100_000_000));
  assert.equal(values.plotSkin, "classic");
  assert.deepEqual(values.unlockedSkins, ["classic"]);
  assert.equal(values.weatherForecast, "rain");
  assert.ok(values.updatedAt instanceof Date);
});

test("2. joueur absent : leve une erreur explicite", async () => {
  const state = buildPlayerState("joueur-inconnu");
  const deps = buildWriteDeps({ lockAndGetPlayer: async () => null });
  await assert.rejects(() => savePlayerWithTx(FAKE_TX, state, deps), /introuvable/);
});

test("3. joueur absent : aucune ecriture n'est tentee apres la verification", async () => {
  const state = buildPlayerState("joueur-inconnu");
  const updatePlayerRow = mock.fn(async (..._args: Parameters<PlayerWriteDeps["updatePlayerRow"]>) => {});
  const upsertPlots = mock.fn(async (..._args: Parameters<PlayerWriteDeps["upsertPlots"]>) => {});
  const upsertInventoryItems = mock.fn(async (..._args: Parameters<PlayerWriteDeps["upsertInventoryItems"]>) => {});
  const deps = buildWriteDeps({
    lockAndGetPlayer: async () => null,
    updatePlayerRow,
    upsertPlots,
    upsertInventoryItems,
  });

  await assert.rejects(() => savePlayerWithTx(FAKE_TX, state, deps));

  assert.equal(updatePlayerRow.mock.calls.length, 0);
  assert.equal(upsertPlots.mock.calls.length, 0);
  assert.equal(upsertInventoryItems.mock.calls.length, 0);
});

test("4. plots correctement upsertes (playerId, plotIndex, cropId, plantedAt, notifiedReady)", async () => {
  const state = buildPlayerState(TEST_PLAYER_ID);
  const upsertPlots = mock.fn(async (..._args: Parameters<PlayerWriteDeps["upsertPlots"]>) => {});
  await savePlayerWithTx(FAKE_TX, state, buildWriteDeps({ upsertPlots }));

  assert.equal(upsertPlots.mock.calls.length, 1);
  const [, rows] = upsertPlots.mock.calls[0]!.arguments;
  assert.deepEqual(rows, [
    { playerId: TEST_PLAYER_ID, plotIndex: 0, cropId: null, plantedAt: null, notifiedReady: false },
    {
      playerId: TEST_PLAYER_ID,
      plotIndex: 1,
      cropId: "wheat",
      plantedAt: new Date(1_700_050_000_000),
      notifiedReady: true,
    },
  ]);
});

test("5. plot avec cropId=null correctement transmis (pas de valeur inventee)", async () => {
  const state = buildPlayerState(TEST_PLAYER_ID, {
    plots: [{ cropId: null, plantedAt: null, notifiedReady: false }],
  });
  const upsertPlots = mock.fn(async (..._args: Parameters<PlayerWriteDeps["upsertPlots"]>) => {});
  await savePlayerWithTx(FAKE_TX, state, buildWriteDeps({ upsertPlots }));

  const [, rows] = upsertPlots.mock.calls[0]!.arguments;
  assert.equal(rows[0].cropId, null);
  assert.equal(rows[0].plantedAt, null);
});

test("6. inventory correctement upserte (itemId -> quantity)", async () => {
  const state = buildPlayerState(TEST_PLAYER_ID);
  const upsertInventoryItems = mock.fn(async (..._args: Parameters<PlayerWriteDeps["upsertInventoryItems"]>) => {});
  await savePlayerWithTx(FAKE_TX, state, buildWriteDeps({ upsertInventoryItems }));

  assert.equal(upsertInventoryItems.mock.calls.length, 1);
  const [, rows] = upsertInventoryItems.mock.calls[0]!.arguments;
  assert.deepEqual(rows, [
    { playerId: TEST_PLAYER_ID, itemId: "wheat", quantity: 5 },
    { playerId: TEST_PLAYER_ID, itemId: "carrot", quantity: 0 },
  ]);
});

test("7. inventory quantity=0 est conservee (pas filtree, pas de suppression)", async () => {
  const state = buildPlayerState(TEST_PLAYER_ID, { inventory: { carrot: 0 } });
  const upsertInventoryItems = mock.fn(async (..._args: Parameters<PlayerWriteDeps["upsertInventoryItems"]>) => {});
  await savePlayerWithTx(FAKE_TX, state, buildWriteDeps({ upsertInventoryItems }));

  const [, rows] = upsertInventoryItems.mock.calls[0]!.arguments;
  assert.deepEqual(rows, [{ playerId: TEST_PLAYER_ID, itemId: "carrot", quantity: 0 }]);
});

test("8. une erreur pendant l'UPDATE est propagee et arrete la sauvegarde", async () => {
  const state = buildPlayerState(TEST_PLAYER_ID);
  const upsertPlots = mock.fn(async (..._args: Parameters<PlayerWriteDeps["upsertPlots"]>) => {});
  const upsertInventoryItems = mock.fn(async (..._args: Parameters<PlayerWriteDeps["upsertInventoryItems"]>) => {});
  const deps = buildWriteDeps({
    updatePlayerRow: async () => {
      throw new Error("echec simule de l'UPDATE");
    },
    upsertPlots,
    upsertInventoryItems,
  });

  await assert.rejects(() => savePlayerWithTx(FAKE_TX, state, deps), /echec simule de l'UPDATE/);
  assert.equal(upsertPlots.mock.calls.length, 0);
  assert.equal(upsertInventoryItems.mock.calls.length, 0);
});

test("8bis. une erreur pendant l'upsert des plots est propagee", async () => {
  const state = buildPlayerState(TEST_PLAYER_ID);
  const upsertInventoryItems = mock.fn(async (..._args: Parameters<PlayerWriteDeps["upsertInventoryItems"]>) => {});
  const deps = buildWriteDeps({
    upsertPlots: async () => {
      throw new Error("echec simule de l'upsert plots");
    },
    upsertInventoryItems,
  });

  await assert.rejects(() => savePlayerWithTx(FAKE_TX, state, deps), /echec simule de l'upsert plots/);
  assert.equal(upsertInventoryItems.mock.calls.length, 0);
});

test("9. savePlayer ouvre une transaction et delegue au coeur transactionnel", async () => {
  const state = buildPlayerState(TEST_PLAYER_ID);
  const lockAndGetPlayer = mock.fn(async (_tx: never, id: string) => buildPlayerRow(id));
  const updatePlayerRow = mock.fn(async (..._args: Parameters<PlayerWriteDeps["updatePlayerRow"]>) => {});
  const deps = buildWriteDeps({ lockAndGetPlayer, updatePlayerRow });

  let transactionOpened = false;
  let txPassedThrough: unknown;
  const fakeRunTransaction = async (fn: (tx: never) => Promise<void>) => {
    transactionOpened = true;
    await fn(FAKE_TX);
  };

  await savePlayer(state, deps, fakeRunTransaction as never);

  assert.equal(transactionOpened, true);
  assert.equal(lockAndGetPlayer.mock.calls.length, 1);
  assert.equal(updatePlayerRow.mock.calls.length, 1);
  txPassedThrough = lockAndGetPlayer.mock.calls[0]!.arguments[0];
  assert.equal(txPassedThrough, FAKE_TX);
});

// 10. "Aucun DELETE" n'est PAS verifie ici par un test runtime exerçant les
// implementations reelles (realLockAndGetPlayer/realUpdatePlayerRow/
// realUpsertPlots/realUpsertInventoryItems) : ces fonctions importent
// dynamiquement @workspace/db/schema, qui reexporte ses fichiers via des
// chemins sans extension -- non resolubles par le runner de test natif de
// Node (--experimental-strip-types) utilise ici, meme en differant
// l'import (voir commentaire dans farmRepository.ts). Verifie desormais par
// une recherche statique AUTOMATISEE (lecture du fichier source, pas
// d'import runtime des implementations reelles) : voir le test
// "mutateGlobalState 14." plus bas, qui couvre tout farmRepository.ts (donc
// aussi bien l'ecriture joueur que l'ecriture globale).

// ===========================================================================
// mutatePlayer -- verrou + lecture (plots/inventory) + mutation en memoire +
// ecriture, dans UNE seule transaction, UN seul SELECT ... FOR UPDATE.
// Mocks/fakes uniquement, jamais de vraie base (meme approche que
// savePlayerWithTx ci-dessus).
// ===========================================================================

function buildFullPlayerRow(id: string, overrides: Partial<Player> = {}): Player {
  return {
    id,
    coins: 50,
    level: 1,
    xp: 0,
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: 50,
    totalHarvested: 0,
    quests: [],
    questsResetAt: NOW,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Player;
}

function buildPlotRow(overrides: Partial<PlotRow> = {}): PlotRow {
  return {
    id: 1,
    playerId: TEST_PLAYER_ID,
    plotIndex: 0,
    cropId: null,
    plantedAt: null,
    notifiedReady: false,
    ...overrides,
  };
}

function buildInventoryItemRow(overrides: Partial<InventoryItemRow> = {}): InventoryItemRow {
  return {
    id: 1,
    playerId: TEST_PLAYER_ID,
    itemId: "wheat",
    quantity: 3,
    ...overrides,
  };
}

function buildMutateDeps(overrides: Partial<MutatePlayerDeps> = {}): MutatePlayerDeps {
  return {
    lockAndGetPlayer: async (_tx, id) => buildFullPlayerRow(id),
    updatePlayerRow: async () => {},
    upsertPlots: async () => {},
    upsertInventoryItems: async () => {},
    getPlotsForUpdate: async () => [],
    getInventoryItemsForUpdate: async () => [],
    toPlayerState,
    ...overrides,
  };
}

// Ouvre une "fausse transaction" qui delegue directement a FAKE_TX -- meme
// principe que le test 9 de savePlayer (fakeRunTransaction), reutilise ici
// pour chaque test de mutatePlayer.
async function runMutatePlayer(
  mutator: (player: PlayerState) => void | Promise<void>,
  deps: MutatePlayerDeps,
): Promise<PlayerState> {
  return mutatePlayer(TEST_PLAYER_ID, mutator, deps, async (fn) => fn(FAKE_TX));
}

test("mutatePlayer 1. ordre strict : lock -> plots -> inventory -> adapter -> mutator -> ecriture, UN SEUL lock", async () => {
  const callOrder: string[] = [];
  const lockAndGetPlayer = mock.fn(async (_tx: never, id: string) => {
    callOrder.push("lock");
    return buildFullPlayerRow(id);
  });
  const getPlotsForUpdate = mock.fn(async (..._args: Parameters<MutatePlayerDeps["getPlotsForUpdate"]>) => {
    callOrder.push("plots");
    return [];
  });
  const getInventoryItemsForUpdate = mock.fn(
    async (..._args: Parameters<MutatePlayerDeps["getInventoryItemsForUpdate"]>) => {
      callOrder.push("inventory");
      return [];
    },
  );
  const toPlayerStateSpy = mock.fn((record: PlayerRecord) => {
    callOrder.push("adapter");
    return toPlayerState(record);
  });
  const updatePlayerRow = mock.fn(async (..._args: Parameters<PlayerWriteDeps["updatePlayerRow"]>) => {
    callOrder.push("write");
  });

  const deps = buildMutateDeps({
    lockAndGetPlayer,
    getPlotsForUpdate,
    getInventoryItemsForUpdate,
    toPlayerState: toPlayerStateSpy,
    updatePlayerRow,
  });

  await runMutatePlayer((player) => {
    callOrder.push("mutator");
    player.coins += 1;
  }, deps);

  assert.deepEqual(callOrder, ["lock", "plots", "inventory", "adapter", "mutator", "write"]);
  assert.equal(lockAndGetPlayer.mock.calls.length, 1);
});

test("mutatePlayer 2. joueur absent : rejette, aucune lecture plots/inventory, mutator jamais appele, aucune ecriture", async () => {
  const getPlotsForUpdate = mock.fn(async (..._args: Parameters<MutatePlayerDeps["getPlotsForUpdate"]>) => []);
  const getInventoryItemsForUpdate = mock.fn(
    async (..._args: Parameters<MutatePlayerDeps["getInventoryItemsForUpdate"]>) => [],
  );
  const mutator = mock.fn((_player: PlayerState) => {});
  const updatePlayerRow = mock.fn(async (..._args: Parameters<PlayerWriteDeps["updatePlayerRow"]>) => {});
  const deps = buildMutateDeps({
    lockAndGetPlayer: async () => null,
    getPlotsForUpdate,
    getInventoryItemsForUpdate,
    updatePlayerRow,
  });

  await assert.rejects(() => runMutatePlayer(mutator, deps), /introuvable/);

  assert.equal(getPlotsForUpdate.mock.calls.length, 0);
  assert.equal(getInventoryItemsForUpdate.mock.calls.length, 0);
  assert.equal(mutator.mock.calls.length, 0);
  assert.equal(updatePlayerRow.mock.calls.length, 0);
});

test("mutatePlayer 3. mutator synchrone qui leve : l'erreur remonte telle quelle, aucune ecriture", async () => {
  const updatePlayerRow = mock.fn(async (..._args: Parameters<PlayerWriteDeps["updatePlayerRow"]>) => {});
  const deps = buildMutateDeps({ updatePlayerRow });

  await assert.rejects(
    () =>
      runMutatePlayer(() => {
        throw new Error("echec metier simule (sync)");
      }, deps),
    /echec metier simule \(sync\)/,
  );

  assert.equal(updatePlayerRow.mock.calls.length, 0);
});

test("mutatePlayer 4. mutator asynchrone qui rejette : l'erreur remonte telle quelle, aucune ecriture", async () => {
  const updatePlayerRow = mock.fn(async (..._args: Parameters<PlayerWriteDeps["updatePlayerRow"]>) => {});
  const deps = buildMutateDeps({ updatePlayerRow });

  await assert.rejects(
    () =>
      runMutatePlayer(async () => {
        throw new Error("echec metier simule (async)");
      }, deps),
    /echec metier simule \(async\)/,
  );

  assert.equal(updatePlayerRow.mock.calls.length, 0);
});

test("mutatePlayer 5. erreur pendant l'ecriture : rejette, mais le mutator a deja ete execute", async () => {
  const mutator = mock.fn((player: PlayerState) => {
    player.coins += 1;
  });
  const deps = buildMutateDeps({
    updatePlayerRow: async () => {
      throw new Error("echec simule de l'UPDATE");
    },
  });

  await assert.rejects(() => runMutatePlayer(mutator, deps), /echec simule de l'UPDATE/);
  assert.equal(mutator.mock.calls.length, 1);
});

test("mutatePlayer 6. la mutation appliquee par le mutator est transmise a l'ecriture", async () => {
  const updatePlayerRow = mock.fn(async (..._args: Parameters<PlayerWriteDeps["updatePlayerRow"]>) => {});
  const deps = buildMutateDeps({ updatePlayerRow });

  await runMutatePlayer((player) => {
    player.coins = 999;
  }, deps);

  assert.equal(updatePlayerRow.mock.calls.length, 1);
  const [, , values] = updatePlayerRow.mock.calls[0]!.arguments;
  assert.equal(values.coins, 999);
});

test("mutatePlayer 7. la valeur retournee reflete la mutation appliquee", async () => {
  const result = await runMutatePlayer((player) => {
    player.coins = 999;
  }, buildMutateDeps());

  assert.equal(result.coins, 999);
});

test("mutatePlayer 8. updatedAt retourne == timestamp ecrit ; createdAt jamais modifie", async () => {
  const updatePlayerRow = mock.fn(async (..._args: Parameters<PlayerWriteDeps["updatePlayerRow"]>) => {});
  const deps = buildMutateDeps({ updatePlayerRow });

  const result = await runMutatePlayer((player) => {
    player.coins += 1;
  }, deps);

  const [, , values] = updatePlayerRow.mock.calls[0]!.arguments;
  assert.ok(values.updatedAt instanceof Date);
  assert.equal(result.updatedAt, values.updatedAt.getTime());
  assert.equal(result.createdAt, NOW.getTime());
  assert.ok(!("createdAt" in values), "createdAt ne doit jamais faire partie des valeurs ecrites");
});

test("mutatePlayer 9. plots et inventaire vides : fonctionne sans erreur", async () => {
  const result = await runMutatePlayer(
    (player) => {
      player.coins += 1;
    },
    buildMutateDeps({ getPlotsForUpdate: async () => [], getInventoryItemsForUpdate: async () => [] }),
  );

  assert.deepEqual(result.plots, []);
  assert.deepEqual(result.inventory, {});
});

test("mutatePlayer 10. ouvre une seule transaction", async () => {
  let transactionCalls = 0;
  const fakeRunTransaction = async (fn: (tx: never) => Promise<PlayerState>) => {
    transactionCalls += 1;
    return fn(FAKE_TX);
  };

  await mutatePlayer(
    TEST_PLAYER_ID,
    (player) => {
      player.coins += 1;
    },
    buildMutateDeps(),
    fakeRunTransaction as never,
  );

  assert.equal(transactionCalls, 1);
});

test("mutatePlayer 11. l'adaptateur est appele avec exactement {player, plots, inventoryItems} construits a partir des lectures", async () => {
  const playerRow = buildFullPlayerRow(TEST_PLAYER_ID);
  const plotRows = [buildPlotRow({ id: 1, plotIndex: 0 })];
  const inventoryRows = [buildInventoryItemRow({ id: 1, itemId: "wheat", quantity: 3 })];
  const toPlayerStateSpy = mock.fn((r: PlayerRecord) => toPlayerState(r));

  const deps = buildMutateDeps({
    lockAndGetPlayer: async () => playerRow,
    getPlotsForUpdate: async () => plotRows,
    getInventoryItemsForUpdate: async () => inventoryRows,
    toPlayerState: toPlayerStateSpy,
  });

  await runMutatePlayer(() => {}, deps);

  assert.equal(toPlayerStateSpy.mock.calls.length, 1);
  assert.deepEqual(toPlayerStateSpy.mock.calls[0]!.arguments[0], {
    player: playerRow,
    plots: plotRows,
    inventoryItems: inventoryRows,
  });
});

// ===========================================================================
// mutateGlobalState -- verrou (global_state -> contract -> daily_challenge
// courant) + lecture + mutation en memoire + ecriture, dans UNE seule
// transaction. Mocks/fakes uniquement, jamais de vraie base (meme approche
// que savePlayerWithTx/mutatePlayer ci-dessus).
// ===========================================================================

function buildMutateGlobalStateDeps(overrides: Partial<MutateGlobalStateDeps> = {}): MutateGlobalStateDeps {
  const record = buildGlobalStateRecord();
  return {
    lockAndGetGlobalState: async () => record.globalState,
    lockAndGetContract: async () => record.contract,
    lockAndGetCurrentDailyChallenge: async () => record.dailyChallenge,
    getDailyChallengeContributors: async () => record.dailyChallengeContributors,
    updateGlobalStateRow: async () => {},
    updateContractRow: async () => {},
    updateDailyChallengeRow: async () => {},
    insertDailyChallengeRow: async () => {},
    toGlobalState,
    ...overrides,
  };
}

async function runMutateGlobalState(
  mutator: (global: GlobalState) => void | Promise<void>,
  deps: MutateGlobalStateDeps,
): Promise<GlobalState> {
  return mutateGlobalState(mutator, deps, async (fn) => fn(FAKE_TX));
}

test("mutateGlobalState 1. ordre strict : global_state -> contract -> daily_challenge -> contributeurs -> adapter -> mutator -> ecriture (global, contract, daily_challenge), transaction unique", async () => {
  const callOrder: string[] = [];
  const record = buildGlobalStateRecord();

  const lockAndGetGlobalState = mock.fn(async () => {
    callOrder.push("lock-global_state");
    return record.globalState;
  });
  const lockAndGetContract = mock.fn(async () => {
    callOrder.push("lock-contract");
    return record.contract;
  });
  const lockAndGetCurrentDailyChallenge = mock.fn(async () => {
    callOrder.push("lock-daily_challenge");
    return record.dailyChallenge;
  });
  const getDailyChallengeContributors = mock.fn(async () => {
    callOrder.push("get-contributors");
    return record.dailyChallengeContributors;
  });
  const toGlobalStateSpy = mock.fn((r: GlobalStateRecord) => {
    callOrder.push("adapter");
    return toGlobalState(r);
  });
  const updateGlobalStateRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateGlobalStateRow"]>) => {
    callOrder.push("write-global_state");
  });
  const updateContractRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateContractRow"]>) => {
    callOrder.push("write-contract");
  });
  const updateDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutateGlobalStateDeps["updateDailyChallengeRow"]>) => {
      callOrder.push("write-daily_challenge (update)");
    },
  );
  const insertDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutateGlobalStateDeps["insertDailyChallengeRow"]>) => {
      callOrder.push("write-daily_challenge (insert)");
    },
  );

  const deps = buildMutateGlobalStateDeps({
    lockAndGetGlobalState,
    lockAndGetContract,
    lockAndGetCurrentDailyChallenge,
    getDailyChallengeContributors,
    toGlobalState: toGlobalStateSpy,
    updateGlobalStateRow,
    updateContractRow,
    updateDailyChallengeRow,
    insertDailyChallengeRow,
  });

  let transactionCalls = 0;
  const fakeRunTransaction = async (fn: (tx: never) => Promise<GlobalState>) => {
    transactionCalls += 1;
    return fn(FAKE_TX);
  };

  await mutateGlobalState(
    (global) => {
      callOrder.push("mutator");
      global.marketMultiplier = 1.1;
    },
    deps,
    fakeRunTransaction as never,
  );

  assert.equal(transactionCalls, 1);
  assert.equal(lockAndGetGlobalState.mock.calls.length, 1);
  assert.equal(lockAndGetContract.mock.calls.length, 1);
  assert.equal(lockAndGetCurrentDailyChallenge.mock.calls.length, 1);
  assert.deepEqual(callOrder, [
    "lock-global_state",
    "lock-contract",
    "lock-daily_challenge",
    "get-contributors",
    "adapter",
    "mutator",
    "write-global_state",
    "write-contract",
    "write-daily_challenge (update)",
  ]);
});

test("mutateGlobalState 2. global_state absent : rejette, aucune autre lecture ni ecriture", async () => {
  const lockAndGetContract = mock.fn(async () => buildGlobalStateRecord().contract);
  const updateGlobalStateRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateGlobalStateRow"]>) => {});
  const deps = buildMutateGlobalStateDeps({
    lockAndGetGlobalState: async () => null,
    lockAndGetContract,
    updateGlobalStateRow,
  });

  await assert.rejects(() => runMutateGlobalState(() => {}, deps), /introuvable/);
  assert.equal(lockAndGetContract.mock.calls.length, 0);
  assert.equal(updateGlobalStateRow.mock.calls.length, 0);
});

test("mutateGlobalState 3. contract absent : rejette (apres verrou global_state), aucune ecriture", async () => {
  const lockAndGetCurrentDailyChallenge = mock.fn(async () => buildGlobalStateRecord().dailyChallenge);
  const updateGlobalStateRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateGlobalStateRow"]>) => {});
  const deps = buildMutateGlobalStateDeps({
    lockAndGetContract: async () => null,
    lockAndGetCurrentDailyChallenge,
    updateGlobalStateRow,
  });

  await assert.rejects(() => runMutateGlobalState(() => {}, deps), /contract introuvable/);
  assert.equal(lockAndGetCurrentDailyChallenge.mock.calls.length, 0);
  assert.equal(updateGlobalStateRow.mock.calls.length, 0);
});

test("mutateGlobalState 4. daily_challenge absent : rejette (apres verrou contract), aucune ecriture", async () => {
  const getDailyChallengeContributors = mock.fn(async () => []);
  const updateGlobalStateRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateGlobalStateRow"]>) => {});
  const deps = buildMutateGlobalStateDeps({
    lockAndGetCurrentDailyChallenge: async () => null,
    getDailyChallengeContributors,
    updateGlobalStateRow,
  });

  await assert.rejects(() => runMutateGlobalState(() => {}, deps), /aucun daily_challenge trouve/);
  assert.equal(getDailyChallengeContributors.mock.calls.length, 0);
  assert.equal(updateGlobalStateRow.mock.calls.length, 0);
});

test("mutateGlobalState 5. mutator synchrone qui leve : l'erreur remonte telle quelle, aucune ecriture", async () => {
  const updateGlobalStateRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateGlobalStateRow"]>) => {});
  const deps = buildMutateGlobalStateDeps({ updateGlobalStateRow });

  await assert.rejects(
    () =>
      runMutateGlobalState(() => {
        throw new Error("echec metier simule (sync)");
      }, deps),
    /echec metier simule \(sync\)/,
  );
  assert.equal(updateGlobalStateRow.mock.calls.length, 0);
});

test("mutateGlobalState 6. mutator asynchrone qui rejette : l'erreur remonte telle quelle, aucune ecriture", async () => {
  const updateGlobalStateRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateGlobalStateRow"]>) => {});
  const deps = buildMutateGlobalStateDeps({ updateGlobalStateRow });

  await assert.rejects(
    () =>
      runMutateGlobalState(async () => {
        throw new Error("echec metier simule (async)");
      }, deps),
    /echec metier simule \(async\)/,
  );
  assert.equal(updateGlobalStateRow.mock.calls.length, 0);
});

test("mutateGlobalState 7. mutator asynchrone qui resout : supporte, mutation appliquee", async () => {
  const result = await runMutateGlobalState(async (global) => {
    await Promise.resolve();
    global.marketMultiplier = 1.2;
  }, buildMutateGlobalStateDeps());

  assert.equal(result.marketMultiplier, 1.2);
});

test("mutateGlobalState 8. global_state correctement persiste", async () => {
  const updateGlobalStateRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateGlobalStateRow"]>) => {});
  const deps = buildMutateGlobalStateDeps({ updateGlobalStateRow });

  await runMutateGlobalState((global) => {
    global.marketMultiplier = 1.3;
    global.previousMarketMultiplier = 1.1;
    global.weather = "rain";
    global.weatherMultiplier = 1.25;
    global.weatherChangedAt = 1_700_100_000_000;
    global.weatherExpiresAt = 1_700_200_000_000;
    global.nextWeatherAt = 1_700_300_000_000;
    global.nextWeatherType = "pests";
    global.weeklyStartedAt = 1_700_400_000_000;
  }, deps);

  assert.equal(updateGlobalStateRow.mock.calls.length, 1);
  const [, values] = updateGlobalStateRow.mock.calls[0]!.arguments;
  assert.equal(values.marketMultiplier, 1.3);
  assert.equal(values.previousMarketMultiplier, 1.1);
  assert.equal(values.weather, "rain");
  assert.equal(values.weatherMultiplier, 1.25);
  assert.deepEqual(values.weatherChangedAt, new Date(1_700_100_000_000));
  assert.deepEqual(values.weatherExpiresAt, new Date(1_700_200_000_000));
  assert.deepEqual(values.nextWeatherAt, new Date(1_700_300_000_000));
  assert.equal(values.nextWeatherType, "pests");
  assert.deepEqual(values.weeklyStartedAt, new Date(1_700_400_000_000));
});

test("mutateGlobalState 8bis. weatherChangedAt/weatherExpiresAt nullable geres quand null", async () => {
  const updateGlobalStateRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateGlobalStateRow"]>) => {});
  const deps = buildMutateGlobalStateDeps({ updateGlobalStateRow });

  await runMutateGlobalState((global) => {
    global.weatherChangedAt = null;
    global.weatherExpiresAt = null;
  }, deps);

  const [, values] = updateGlobalStateRow.mock.calls[0]!.arguments;
  assert.equal(values.weatherChangedAt, null);
  assert.equal(values.weatherExpiresAt, null);
});

test("mutateGlobalState 9. contract correctement persiste", async () => {
  const updateContractRow = mock.fn(async (..._args: Parameters<MutateGlobalStateDeps["updateContractRow"]>) => {});
  const deps = buildMutateGlobalStateDeps({ updateContractRow });

  await runMutateGlobalState((global) => {
    global.contract = {
      cropId: "carrot",
      required: 30,
      remaining: 15,
      bonusMultiplier: 1.8,
      renewedAt: 1_700_500_000_000,
    };
  }, deps);

  assert.equal(updateContractRow.mock.calls.length, 1);
  const [, values] = updateContractRow.mock.calls[0]!.arguments;
  assert.equal(values.cropId, "carrot");
  assert.equal(values.required, 30);
  assert.equal(values.remaining, 15);
  assert.equal(values.bonusMultiplier, 1.8);
  assert.deepEqual(values.renewedAt, new Date(1_700_500_000_000));
});

test("mutateGlobalState 10. meme defi (startedAt inchange) : UPDATE de la ligne existante, jamais d'INSERT", async () => {
  const updateDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutateGlobalStateDeps["updateDailyChallengeRow"]>) => {},
  );
  const insertDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutateGlobalStateDeps["insertDailyChallengeRow"]>) => {},
  );
  const deps = buildMutateGlobalStateDeps({ updateDailyChallengeRow, insertDailyChallengeRow });

  await runMutateGlobalState((global) => {
    global.dailyChallenge.progress = 150;
    global.dailyChallenge.completed = false;
  }, deps);

  assert.equal(updateDailyChallengeRow.mock.calls.length, 1);
  assert.equal(insertDailyChallengeRow.mock.calls.length, 0);
  const [, challengeId, values] = updateDailyChallengeRow.mock.calls[0]!.arguments;
  assert.equal(challengeId, 1); // id de la ligne verrouillee (fixture)
  assert.equal(values.progress, 150);
  assert.equal(values.completed, false);
  assert.deepEqual(values.startedAt, new Date(1_700_000_000_000)); // NOW, inchange
});

test("mutateGlobalState 11. renouvellement (startedAt different) : INSERT d'une nouvelle ligne, jamais d'UPDATE, ancienne ligne non touchee", async () => {
  const updateDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutateGlobalStateDeps["updateDailyChallengeRow"]>) => {},
  );
  const insertDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutateGlobalStateDeps["insertDailyChallengeRow"]>) => {},
  );
  const deps = buildMutateGlobalStateDeps({ updateDailyChallengeRow, insertDailyChallengeRow });

  const NEW_STARTED_AT = 1_700_600_000_000;
  await runMutateGlobalState((global) => {
    global.dailyChallenge = {
      cropId: "potato",
      target: 100,
      progress: 0,
      contributors: [],
      rewardCoins: 110,
      startedAt: NEW_STARTED_AT,
      completed: false,
      rewarded: false,
    };
  }, deps);

  assert.equal(insertDailyChallengeRow.mock.calls.length, 1);
  assert.equal(updateDailyChallengeRow.mock.calls.length, 0);
  const [, values] = insertDailyChallengeRow.mock.calls[0]!.arguments;
  assert.equal(values.cropId, "potato");
  assert.equal(values.target, 100);
  assert.equal(values.rewardCoins, 110);
  assert.deepEqual(values.startedAt, new Date(NEW_STARTED_AT));
  assert.equal(values.completed, false);
  assert.equal(values.rewarded, false);
});

test("mutateGlobalState 12. resultat retourne = GlobalState apres mutation", async () => {
  const result = await runMutateGlobalState((global) => {
    global.marketMultiplier = 1.05;
    global.contract.remaining = 12;
  }, buildMutateGlobalStateDeps());

  assert.equal(result.marketMultiplier, 1.05);
  assert.equal(result.contract.remaining, 12);
});

test("mutateGlobalState 13. erreur pendant l'ecriture : rejette, mais le mutator a deja ete execute", async () => {
  const mutator = mock.fn((global: GlobalState) => {
    global.marketMultiplier = 1.4;
  });
  const deps = buildMutateGlobalStateDeps({
    updateGlobalStateRow: async () => {
      throw new Error("echec simule de l'UPDATE global_state");
    },
  });

  await assert.rejects(() => runMutateGlobalState(mutator, deps), /echec simule de l'UPDATE global_state/);
  assert.equal(mutator.mock.calls.length, 1);
});

test("mutateGlobalState 14. farmRepository.ts n'utilise ni FarmStore/getFarmStore, ni discord.js/express, aucun DELETE dans le code d'ecriture global", async () => {
  const filePath = new URL("./farmRepository.ts", import.meta.url);
  const source = await readFile(filePath, "utf8");
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line))
    .join("\n");

  assert.ok(!/FarmStore/.test(importLines), "aucun import de FarmStore attendu");
  assert.ok(!/getFarmStore/.test(importLines), "aucun import de getFarmStore attendu");
  assert.ok(!/from ["']\.\/store/.test(importLines), "aucun import de ./store attendu");
  assert.ok(!/from ["']\.\/sharedStore/.test(importLines), "aucun import de ./sharedStore attendu");
  assert.ok(!/discord\.js/.test(importLines), "aucune dependance discord.js attendue");
  assert.ok(!/["']express["']/.test(importLines), "aucune dependance express attendue");
  assert.ok(!/\.delete\(/.test(source), "aucun .delete( attendu dans farmRepository.ts");
});

// ===========================================================================
// mutatePlayerAndGlobal -- verrou (global_state -> contract -> daily_challenge
// -> player) + lecture + mutation en memoire (player ET global) + ecriture,
// dans UNE seule transaction. Mocks/fakes uniquement, jamais de vraie base
// (meme approche que mutatePlayer/mutateGlobalState ci-dessus).
// ===========================================================================

function buildMutatePlayerAndGlobalDeps(
  overrides: Partial<MutatePlayerAndGlobalDeps> = {},
): MutatePlayerAndGlobalDeps {
  const globalRecord = buildGlobalStateRecord();
  return {
    lockAndGetGlobalState: async () => globalRecord.globalState,
    lockAndGetContract: async () => globalRecord.contract,
    lockAndGetCurrentDailyChallenge: async () => globalRecord.dailyChallenge,
    getDailyChallengeContributors: async () => globalRecord.dailyChallengeContributors,
    updateGlobalStateRow: async () => {},
    updateContractRow: async () => {},
    updateDailyChallengeRow: async () => {},
    insertDailyChallengeRow: async () => {},
    upsertDailyChallengeContributors: async () => {},
    toGlobalState,
    lockAndGetPlayer: async (_tx, id) => buildFullPlayerRow(id),
    updatePlayerRow: async () => {},
    upsertPlots: async () => {},
    upsertInventoryItems: async () => {},
    getPlotsForUpdate: async () => [],
    getInventoryItemsForUpdate: async () => [],
    toPlayerState,
    ...overrides,
  };
}

async function runMutatePlayerAndGlobal(
  mutator: (player: PlayerState, global: GlobalState) => void | Promise<void>,
  deps: MutatePlayerAndGlobalDeps,
): Promise<{ player: PlayerState; global: GlobalState }> {
  return mutatePlayerAndGlobal(TEST_PLAYER_ID, mutator, deps, async (fn) => fn(FAKE_TX));
}

test("mutatePlayerAndGlobal 1. ordre strict : global_state -> contract -> daily_challenge -> contributeurs -> player -> plots -> inventory -> adapters -> mutator -> ecriture (global, contract, daily_challenge, player), transaction unique", async () => {
  const callOrder: string[] = [];
  const globalRecord = buildGlobalStateRecord();

  const lockAndGetGlobalState = mock.fn(async () => {
    callOrder.push("lock-global_state");
    return globalRecord.globalState;
  });
  const lockAndGetContract = mock.fn(async () => {
    callOrder.push("lock-contract");
    return globalRecord.contract;
  });
  const lockAndGetCurrentDailyChallenge = mock.fn(async () => {
    callOrder.push("lock-daily_challenge");
    return globalRecord.dailyChallenge;
  });
  const getDailyChallengeContributors = mock.fn(async () => {
    callOrder.push("get-contributors");
    return globalRecord.dailyChallengeContributors;
  });
  const lockAndGetPlayer = mock.fn(async (_tx: never, id: string) => {
    callOrder.push("lock-player");
    return buildFullPlayerRow(id);
  });
  const getPlotsForUpdate = mock.fn(async (..._args: Parameters<MutatePlayerAndGlobalDeps["getPlotsForUpdate"]>) => {
    callOrder.push("get-plots");
    return [];
  });
  const getInventoryItemsForUpdate = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["getInventoryItemsForUpdate"]>) => {
      callOrder.push("get-inventory");
      return [];
    },
  );
  const toGlobalStateSpy = mock.fn((r: GlobalStateRecord) => {
    callOrder.push("adapter-global");
    return toGlobalState(r);
  });
  const toPlayerStateSpy = mock.fn((r: PlayerRecord) => {
    callOrder.push("adapter-player");
    return toPlayerState(r);
  });
  const updateGlobalStateRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateGlobalStateRow"]>) => {
      callOrder.push("write-global_state");
    },
  );
  const updateContractRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateContractRow"]>) => {
      callOrder.push("write-contract");
    },
  );
  const updateDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateDailyChallengeRow"]>) => {
      callOrder.push("write-daily_challenge");
    },
  );
  const updatePlayerRow = mock.fn(async (..._args: Parameters<MutatePlayerAndGlobalDeps["updatePlayerRow"]>) => {
    callOrder.push("write-player");
  });

  const deps = buildMutatePlayerAndGlobalDeps({
    lockAndGetGlobalState,
    lockAndGetContract,
    lockAndGetCurrentDailyChallenge,
    getDailyChallengeContributors,
    lockAndGetPlayer,
    getPlotsForUpdate,
    getInventoryItemsForUpdate,
    toGlobalState: toGlobalStateSpy,
    toPlayerState: toPlayerStateSpy,
    updateGlobalStateRow,
    updateContractRow,
    updateDailyChallengeRow,
    updatePlayerRow,
  });

  let transactionCalls = 0;
  const fakeRunTransaction = async (fn: (tx: never) => Promise<{ player: PlayerState; global: GlobalState }>) => {
    transactionCalls += 1;
    return fn(FAKE_TX);
  };

  await mutatePlayerAndGlobal(
    TEST_PLAYER_ID,
    (player, global) => {
      callOrder.push("mutator");
      player.coins += 1;
      global.marketMultiplier = 1.1;
    },
    deps,
    fakeRunTransaction as never,
  );

  assert.equal(transactionCalls, 1);
  assert.equal(lockAndGetGlobalState.mock.calls.length, 1);
  assert.equal(lockAndGetContract.mock.calls.length, 1);
  assert.equal(lockAndGetCurrentDailyChallenge.mock.calls.length, 1);
  assert.equal(lockAndGetPlayer.mock.calls.length, 1);
  assert.deepEqual(callOrder, [
    "lock-global_state",
    "lock-contract",
    "lock-daily_challenge",
    "get-contributors",
    "lock-player",
    "get-plots",
    "get-inventory",
    "adapter-global",
    "adapter-player",
    "mutator",
    "write-global_state",
    "write-contract",
    "write-daily_challenge",
    "write-player",
  ]);
});

test("mutatePlayerAndGlobal 2. global_state absent : rejette, aucune autre lecture ni ecriture", async () => {
  const lockAndGetContract = mock.fn(async () => buildGlobalStateRecord().contract);
  const lockAndGetPlayer = mock.fn(async (_tx: never, id: string) => buildFullPlayerRow(id));
  const updateGlobalStateRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateGlobalStateRow"]>) => {},
  );
  const deps = buildMutatePlayerAndGlobalDeps({
    lockAndGetGlobalState: async () => null,
    lockAndGetContract,
    lockAndGetPlayer,
    updateGlobalStateRow,
  });

  await assert.rejects(() => runMutatePlayerAndGlobal(() => {}, deps), /introuvable/);
  assert.equal(lockAndGetContract.mock.calls.length, 0);
  assert.equal(lockAndGetPlayer.mock.calls.length, 0);
  assert.equal(updateGlobalStateRow.mock.calls.length, 0);
});

test("mutatePlayerAndGlobal 3. contract absent : rejette (apres verrou global_state), aucune ecriture", async () => {
  const lockAndGetCurrentDailyChallenge = mock.fn(async () => buildGlobalStateRecord().dailyChallenge);
  const lockAndGetPlayer = mock.fn(async (_tx: never, id: string) => buildFullPlayerRow(id));
  const deps = buildMutatePlayerAndGlobalDeps({
    lockAndGetContract: async () => null,
    lockAndGetCurrentDailyChallenge,
    lockAndGetPlayer,
  });

  await assert.rejects(() => runMutatePlayerAndGlobal(() => {}, deps), /contract introuvable/);
  assert.equal(lockAndGetCurrentDailyChallenge.mock.calls.length, 0);
  assert.equal(lockAndGetPlayer.mock.calls.length, 0);
});

test("mutatePlayerAndGlobal 4. daily_challenge absent : rejette (apres verrou contract), aucune ecriture", async () => {
  const lockAndGetPlayer = mock.fn(async (_tx: never, id: string) => buildFullPlayerRow(id));
  const deps = buildMutatePlayerAndGlobalDeps({
    lockAndGetCurrentDailyChallenge: async () => null,
    lockAndGetPlayer,
  });

  await assert.rejects(() => runMutatePlayerAndGlobal(() => {}, deps), /aucun daily_challenge trouve/);
  assert.equal(lockAndGetPlayer.mock.calls.length, 0);
});

test("mutatePlayerAndGlobal 5. joueur absent (apres verrous global_state/contract/daily_challenge) : rejette, aucune lecture plots/inventory, aucune ecriture", async () => {
  const getPlotsForUpdate = mock.fn(async (..._args: Parameters<MutatePlayerAndGlobalDeps["getPlotsForUpdate"]>) => []);
  const updateGlobalStateRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateGlobalStateRow"]>) => {},
  );
  const updatePlayerRow = mock.fn(async (..._args: Parameters<MutatePlayerAndGlobalDeps["updatePlayerRow"]>) => {});
  const deps = buildMutatePlayerAndGlobalDeps({
    lockAndGetPlayer: async () => null,
    getPlotsForUpdate,
    updateGlobalStateRow,
    updatePlayerRow,
  });

  await assert.rejects(() => runMutatePlayerAndGlobal(() => {}, deps), /introuvable/);
  assert.equal(getPlotsForUpdate.mock.calls.length, 0);
  assert.equal(updateGlobalStateRow.mock.calls.length, 0);
  assert.equal(updatePlayerRow.mock.calls.length, 0);
});

test("mutatePlayerAndGlobal 6. mutator synchrone qui leve : l'erreur remonte telle quelle, aucune ecriture", async () => {
  const updateGlobalStateRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateGlobalStateRow"]>) => {},
  );
  const updatePlayerRow = mock.fn(async (..._args: Parameters<MutatePlayerAndGlobalDeps["updatePlayerRow"]>) => {});
  const deps = buildMutatePlayerAndGlobalDeps({ updateGlobalStateRow, updatePlayerRow });

  await assert.rejects(
    () =>
      runMutatePlayerAndGlobal(() => {
        throw new Error("echec metier simule (sync)");
      }, deps),
    /echec metier simule \(sync\)/,
  );
  assert.equal(updateGlobalStateRow.mock.calls.length, 0);
  assert.equal(updatePlayerRow.mock.calls.length, 0);
});

test("mutatePlayerAndGlobal 7. mutator asynchrone qui rejette : l'erreur remonte telle quelle, aucune ecriture", async () => {
  const updateGlobalStateRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateGlobalStateRow"]>) => {},
  );
  const updatePlayerRow = mock.fn(async (..._args: Parameters<MutatePlayerAndGlobalDeps["updatePlayerRow"]>) => {});
  const deps = buildMutatePlayerAndGlobalDeps({ updateGlobalStateRow, updatePlayerRow });

  await assert.rejects(
    () =>
      runMutatePlayerAndGlobal(async () => {
        throw new Error("echec metier simule (async)");
      }, deps),
    /echec metier simule \(async\)/,
  );
  assert.equal(updateGlobalStateRow.mock.calls.length, 0);
  assert.equal(updatePlayerRow.mock.calls.length, 0);
});

test("mutatePlayerAndGlobal 8. mutator asynchrone qui resout : supporte, mutations player+global appliquees", async () => {
  const result = await runMutatePlayerAndGlobal(async (player, global) => {
    await Promise.resolve();
    player.coins += 5;
    global.marketMultiplier = 1.15;
  }, buildMutatePlayerAndGlobalDeps());

  assert.equal(result.player.coins, 55); // fixture par defaut : coins=50
  assert.equal(result.global.marketMultiplier, 1.15);
});

test("mutatePlayerAndGlobal 9. erreur pendant l'ecriture globale : rejette, mutator deja execute, ecriture joueur jamais tentee", async () => {
  const mutator = mock.fn((player: PlayerState, global: GlobalState) => {
    player.coins += 1;
    global.marketMultiplier = 1.2;
  });
  const updatePlayerRow = mock.fn(async (..._args: Parameters<MutatePlayerAndGlobalDeps["updatePlayerRow"]>) => {});
  const deps = buildMutatePlayerAndGlobalDeps({
    updateGlobalStateRow: async () => {
      throw new Error("echec simule de l'UPDATE global_state");
    },
    updatePlayerRow,
  });

  await assert.rejects(() => runMutatePlayerAndGlobal(mutator, deps), /echec simule de l'UPDATE global_state/);
  assert.equal(mutator.mock.calls.length, 1);
  assert.equal(updatePlayerRow.mock.calls.length, 0);
});

test("mutatePlayerAndGlobal 10. retour player/global apres mutation, createdAt inchange, updatedAt coherent", async () => {
  const updatePlayerRow = mock.fn(async (..._args: Parameters<MutatePlayerAndGlobalDeps["updatePlayerRow"]>) => {});
  const deps = buildMutatePlayerAndGlobalDeps({ updatePlayerRow });

  const result = await runMutatePlayerAndGlobal((player, global) => {
    player.coins = 999;
    global.marketMultiplier = 1.05;
  }, deps);

  assert.equal(result.player.coins, 999);
  assert.equal(result.global.marketMultiplier, 1.05);

  const [, , values] = updatePlayerRow.mock.calls[0]!.arguments;
  assert.ok(!("createdAt" in values), "createdAt ne doit jamais faire partie des valeurs ecrites");
  assert.ok(values.updatedAt instanceof Date);
  assert.equal(result.player.updatedAt, values.updatedAt.getTime());
  assert.equal(result.player.createdAt, NOW.getTime());
});

test("mutatePlayerAndGlobal 11. contract correctement persiste", async () => {
  const updateContractRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateContractRow"]>) => {},
  );
  const deps = buildMutatePlayerAndGlobalDeps({ updateContractRow });

  await runMutatePlayerAndGlobal((_player, global) => {
    global.contract.remaining -= 3;
  }, deps);

  assert.equal(updateContractRow.mock.calls.length, 1);
  const [, values] = updateContractRow.mock.calls[0]!.arguments;
  assert.equal(values.remaining, 17); // fixture par defaut : remaining=20
  assert.equal(values.cropId, "wheat");
  assert.equal(values.required, 20);
});

test("mutatePlayerAndGlobal 12. meme defi (startedAt inchange) : UPDATE de la ligne existante, jamais d'INSERT", async () => {
  const updateDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateDailyChallengeRow"]>) => {},
  );
  const insertDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["insertDailyChallengeRow"]>) => {},
  );
  const deps = buildMutatePlayerAndGlobalDeps({ updateDailyChallengeRow, insertDailyChallengeRow });

  await runMutatePlayerAndGlobal((_player, global) => {
    global.dailyChallenge.progress += 50;
  }, deps);

  assert.equal(updateDailyChallengeRow.mock.calls.length, 1);
  assert.equal(insertDailyChallengeRow.mock.calls.length, 0);
  const [, challengeId, values] = updateDailyChallengeRow.mock.calls[0]!.arguments;
  assert.equal(challengeId, 1); // id de la ligne verrouillee (fixture)
  assert.equal(values.progress, 50);
});

test("mutatePlayerAndGlobal 13. renouvellement (startedAt different) : INSERT d'une nouvelle ligne, jamais d'UPDATE, aucun upsert de contributeurs", async () => {
  const updateDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["updateDailyChallengeRow"]>) => {},
  );
  const insertDailyChallengeRow = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["insertDailyChallengeRow"]>) => {},
  );
  const upsertDailyChallengeContributors = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["upsertDailyChallengeContributors"]>) => {},
  );
  const deps = buildMutatePlayerAndGlobalDeps({
    updateDailyChallengeRow,
    insertDailyChallengeRow,
    upsertDailyChallengeContributors,
  });

  const NEW_STARTED_AT = 1_700_600_000_000;
  await runMutatePlayerAndGlobal((_player, global) => {
    global.dailyChallenge = {
      cropId: "potato",
      target: 100,
      progress: 0,
      contributors: [],
      rewardCoins: 110,
      startedAt: NEW_STARTED_AT,
      completed: false,
      rewarded: false,
    };
  }, deps);

  assert.equal(insertDailyChallengeRow.mock.calls.length, 1);
  assert.equal(updateDailyChallengeRow.mock.calls.length, 0);
  assert.equal(upsertDailyChallengeContributors.mock.calls.length, 0);
});

test("mutatePlayerAndGlobal 14. nouveau contributeur ajoute au defi courant : upsert avec le bon challengeId, sans doublon (liste complete, ON CONFLICT DO NOTHING cote reel)", async () => {
  const upsertDailyChallengeContributors = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["upsertDailyChallengeContributors"]>) => {},
  );
  const deps = buildMutatePlayerAndGlobalDeps({ upsertDailyChallengeContributors });

  await runMutatePlayerAndGlobal((player, global) => {
    if (!global.dailyChallenge.contributors.includes(player.userId)) {
      global.dailyChallenge.contributors.push(player.userId);
    }
    global.dailyChallenge.progress += 10;
  }, deps);

  assert.equal(upsertDailyChallengeContributors.mock.calls.length, 1);
  const [, rows] = upsertDailyChallengeContributors.mock.calls[0]!.arguments;
  assert.deepEqual(rows, [{ challengeId: 1, playerId: TEST_PLAYER_ID }]);
});

test("mutatePlayerAndGlobal 15. aucun nouveau contributeur (contributors vide) : upsert non tente", async () => {
  const upsertDailyChallengeContributors = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["upsertDailyChallengeContributors"]>) => {},
  );
  const deps = buildMutatePlayerAndGlobalDeps({ upsertDailyChallengeContributors });

  await runMutatePlayerAndGlobal((_player, global) => {
    global.dailyChallenge.progress += 1;
  }, deps);

  assert.equal(upsertDailyChallengeContributors.mock.calls.length, 0);
});

test("mutatePlayerAndGlobal 16. plots/inventory lus APRES le verrou du joueur, mutator execute seulement apres toutes les lectures (rejeu explicite hors du test d'ordre global)", async () => {
  const callOrder: string[] = [];
  const lockAndGetPlayer = mock.fn(async (_tx: never, id: string) => {
    callOrder.push("lock-player");
    return buildFullPlayerRow(id);
  });
  const getPlotsForUpdate = mock.fn(async (..._args: Parameters<MutatePlayerAndGlobalDeps["getPlotsForUpdate"]>) => {
    callOrder.push("get-plots");
    return [buildPlotRow({ id: 1, plotIndex: 0 })];
  });
  const getInventoryItemsForUpdate = mock.fn(
    async (..._args: Parameters<MutatePlayerAndGlobalDeps["getInventoryItemsForUpdate"]>) => {
      callOrder.push("get-inventory");
      return [buildInventoryItemRow({ id: 1, itemId: "wheat", quantity: 3 })];
    },
  );
  const deps = buildMutatePlayerAndGlobalDeps({ lockAndGetPlayer, getPlotsForUpdate, getInventoryItemsForUpdate });

  await runMutatePlayerAndGlobal(() => {
    callOrder.push("mutator");
  }, deps);

  assert.deepEqual(callOrder, ["lock-player", "get-plots", "get-inventory", "mutator"]);
});
