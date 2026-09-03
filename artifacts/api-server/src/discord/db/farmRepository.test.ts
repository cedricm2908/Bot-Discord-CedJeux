// Tests de farmRepository.ts UNIQUEMENT (createFarmRepository, factory pure).
// Aucune connexion PostgreSQL : ces tests n'importent jamais
// @workspace/db/repositories comme valeur d'execution, seulement des DTO
// construits en memoire passes comme dependances mockees. Les adaptateurs
// REELS (toPlayerState/toGlobalState) sont utilises tels quels pour prouver
// l'integration bout en bout, sans jamais toucher @workspace/db.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { GlobalStateRecord, PlayerRecord } from "@workspace/db/repositories";
import { createFarmRepository, type FarmRepositoryDeps } from "./farmRepository.ts";
import { toGlobalState } from "./globalStateAdapter.ts";
import { toPlayerState } from "./playerAdapter.ts";

const NOW = new Date(1_700_000_000_000);

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
