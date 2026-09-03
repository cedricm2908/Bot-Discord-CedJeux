// Tests de globalStateAdapter.ts UNIQUEMENT (transformation DTO -> GlobalState).
// Aucune connexion PostgreSQL : GlobalStateRecord n'est ici qu'un type
// (import "type"), efface a la compilation.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GlobalStateRecord } from "@workspace/db/repositories";
import { toGlobalState } from "./globalStateAdapter.ts";

function buildRecord(overrides: Partial<GlobalStateRecord> = {}): GlobalStateRecord {
  const base: GlobalStateRecord = {
    globalState: {
      id: 1,
      marketMultiplier: 1.12,
      previousMarketMultiplier: 0.95,
      marketUpdatedAt: new Date(1_700_000_000_000),
      weather: "rain",
      weatherMultiplier: 1.25,
      weatherChangedAt: new Date(1_700_010_000_000),
      weatherExpiresAt: new Date(1_700_020_000_000),
      nextWeatherAt: new Date(1_700_030_000_000),
      nextWeatherType: "pests",
      weeklyStartedAt: new Date(1_699_000_000_000),
    },
    contract: {
      id: 1,
      cropId: "wheat",
      required: 20,
      remaining: 8,
      bonusMultiplier: 1.6,
      renewedAt: new Date(1_699_500_000_000),
    },
    dailyChallenge: {
      id: 5,
      cropId: "carrot",
      target: 150,
      progress: 60,
      rewardCoins: 90,
      startedAt: new Date(1_700_040_000_000),
      completed: false,
      rewarded: false,
    },
    dailyChallengeContributors: [
      { challengeId: 5, playerId: "user-1", contributedAt: new Date(1_700_041_000_000) },
      { challengeId: 5, playerId: "user-2", contributedAt: new Date(1_700_042_000_000) },
    ],
  };
  return {
    ...base,
    ...overrides,
    globalState: { ...base.globalState, ...overrides.globalState },
    contract: { ...base.contract, ...overrides.contract },
    dailyChallenge: { ...base.dailyChallenge, ...overrides.dailyChallenge },
  };
}

test("1. convertit tous les timestamps en epoch ms (nombre)", () => {
  const state = toGlobalState(buildRecord());
  assert.equal(state.marketUpdatedAt, 1_700_000_000_000);
  assert.equal(state.weatherChangedAt, 1_700_010_000_000);
  assert.equal(state.weatherExpiresAt, 1_700_020_000_000);
  assert.equal(state.nextWeatherAt, 1_700_030_000_000);
  assert.equal(state.weeklyStartedAt, 1_699_000_000_000);
  assert.equal(state.contract.renewedAt, 1_699_500_000_000);
  assert.equal(state.dailyChallenge.startedAt, 1_700_040_000_000);
  assert.equal(typeof state.marketUpdatedAt, "number");
});

test("1bis. timestamps nullable (weatherChangedAt/weatherExpiresAt) geres quand null", () => {
  const state = toGlobalState(
    buildRecord({ globalState: { weatherChangedAt: null, weatherExpiresAt: null } as never }),
  );
  assert.equal(state.weatherChangedAt, null);
  assert.equal(state.weatherExpiresAt, null);
});

test("2. market multipliers correctement reconstruits", () => {
  const state = toGlobalState(buildRecord());
  assert.equal(state.marketMultiplier, 1.12);
  assert.equal(state.previousMarketMultiplier, 0.95);
});

test("3. weather / nextWeatherType correctement reconstruits", () => {
  const state = toGlobalState(buildRecord());
  assert.equal(state.weather, "rain");
  assert.equal(state.weatherMultiplier, 1.25);
  assert.equal(state.nextWeatherType, "pests");
});

test("4. contract correctement reconstruit (toutes les proprietes)", () => {
  const state = toGlobalState(buildRecord());
  assert.deepEqual(state.contract, {
    cropId: "wheat",
    required: 20,
    remaining: 8,
    bonusMultiplier: 1.6,
    renewedAt: 1_699_500_000_000,
  });
});

test("5. dailyChallenge correctement reconstruit (hors contributors)", () => {
  const state = toGlobalState(buildRecord());
  assert.equal(state.dailyChallenge.cropId, "carrot");
  assert.equal(state.dailyChallenge.target, 150);
  assert.equal(state.dailyChallenge.progress, 60);
  assert.equal(state.dailyChallenge.rewardCoins, 90);
  assert.equal(state.dailyChallenge.completed, false);
  assert.equal(state.dailyChallenge.rewarded, false);
});

test("6. contributors correctement reconstruits (liste des playerId)", () => {
  const state = toGlobalState(buildRecord());
  assert.deepEqual(state.dailyChallenge.contributors, ["user-1", "user-2"]);
});

test("6bis. contributors vide quand aucune ligne", () => {
  const state = toGlobalState(buildRecord({ dailyChallengeContributors: [] }));
  assert.deepEqual(state.dailyChallenge.contributors, []);
});

test("7. toutes les proprietes de GlobalState presentes avec les bonnes valeurs", () => {
  const state = toGlobalState(buildRecord());
  assert.deepStrictEqual(state, {
    marketMultiplier: 1.12,
    previousMarketMultiplier: 0.95,
    marketUpdatedAt: 1_700_000_000_000,
    weather: "rain",
    weatherMultiplier: 1.25,
    weatherChangedAt: 1_700_010_000_000,
    weatherExpiresAt: 1_700_020_000_000,
    nextWeatherAt: 1_700_030_000_000,
    nextWeatherType: "pests",
    contract: {
      cropId: "wheat",
      required: 20,
      remaining: 8,
      bonusMultiplier: 1.6,
      renewedAt: 1_699_500_000_000,
    },
    weeklyStartedAt: 1_699_000_000_000,
    dailyChallenge: {
      cropId: "carrot",
      target: 150,
      progress: 60,
      contributors: ["user-1", "user-2"],
      rewardCoins: 90,
      startedAt: 1_700_040_000_000,
      completed: false,
      rewarded: false,
    },
  });
});
