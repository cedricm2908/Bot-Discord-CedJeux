// Tests de farmRepository.ts (lecture ET ecriture). Aucune connexion
// PostgreSQL : ces tests n'importent jamais @workspace/db ou
// @workspace/db/repositories comme valeur d'execution -- uniquement des DTO
// construits en memoire et des dependances mockees (PlayerWriteDeps pour
// l'ecriture, FarmRepositoryDeps pour la lecture). Les adaptateurs REELS
// (toPlayerState/toGlobalState) sont utilises tels quels pour prouver
// l'integration bout en bout, sans jamais toucher @workspace/db.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { GlobalStateRecord, PlayerRecord } from "@workspace/db/repositories";
import type { Player } from "@workspace/db";
import {
  createFarmRepository,
  savePlayer,
  savePlayerWithTx,
  type FarmRepositoryDeps,
  type PlayerWriteDeps,
} from "./farmRepository.ts";
import { toGlobalState } from "./globalStateAdapter.ts";
import { toPlayerState } from "./playerAdapter.ts";
import type { PlayerState } from "../types";

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
// l'import (voir commentaire dans farmRepository.ts). Verifie a la place
// par recherche statique (grep) sur farmRepository.ts, rapportee dans le
// resume de cette etape : confirmé qu'aucun `.delete(` n'y apparait.
