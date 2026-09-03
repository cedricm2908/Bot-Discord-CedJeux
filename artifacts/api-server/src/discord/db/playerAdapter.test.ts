// Tests de playerAdapter.ts UNIQUEMENT (transformation DTO -> PlayerState).
// Aucune connexion PostgreSQL : PlayerRecord n'est ici qu'un type (import
// "type"), efface a la compilation -- ces tests n'importent et n'executent
// jamais lib/db/src/index.ts (celui qui ouvre un Pool reel).
// Les regles de gameplay (farm.ts) ne sont pas testees ici.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerRecord } from "@workspace/db/repositories";
import { toPlayerState } from "./playerAdapter.ts";

function buildRecord(overrides: Partial<PlayerRecord> = {}): PlayerRecord {
  const base: PlayerRecord = {
    player: {
      id: "user-1",
      coins: 120,
      level: 3,
      xp: 42,
      irrigationLevel: 2,
      fertilizerLevel: 1,
      lastDailyAt: new Date(1_700_000_000_000),
      autoReplant: true,
      weeklySnapshotCoins: 100,
      totalHarvested: 57,
      quests: [
        {
          type: "harvest",
          label: "Recolter 10 cultures",
          target: 10,
          progress: 4,
          rewardCoins: 40,
          claimed: false,
        },
      ],
      questsResetAt: new Date(1_700_100_000_000),
      plotSkin: "autumn",
      unlockedSkins: ["classic", "autumn"],
      weatherForecast: "rain",
      createdAt: new Date(1_699_000_000_000),
      updatedAt: new Date(1_700_200_000_000),
    },
    // Ordre deja croissant par plotIndex : c'est la responsabilite du
    // repository (ORDER BY plot_index) de fournir cet ordre, pas de
    // l'adaptateur -- on teste ici que l'adaptateur PRESERVE fidelement
    // l'ordre et la correspondance d'index recus, pas qu'il trie lui-meme.
    plots: [
      { id: 1, playerId: "user-1", plotIndex: 0, cropId: null, plantedAt: null, notifiedReady: false },
      {
        id: 2,
        playerId: "user-1",
        plotIndex: 1,
        cropId: "carrot",
        plantedAt: new Date(1_700_050_000_000),
        notifiedReady: false,
      },
    ],
    inventoryItems: [
      { id: 10, playerId: "user-1", itemId: "wheat", quantity: 5 },
      { id: 11, playerId: "user-1", itemId: "bread", quantity: 2 },
    ],
  };
  return { ...base, ...overrides, player: { ...base.player, ...overrides.player } };
}

test("1. convertit toutes les Date en epoch ms (nombre)", () => {
  const state = toPlayerState(buildRecord());
  assert.equal(state.lastDailyAt, 1_700_000_000_000);
  assert.equal(state.questsResetAt, 1_700_100_000_000);
  assert.equal(state.createdAt, 1_699_000_000_000);
  assert.equal(state.updatedAt, 1_700_200_000_000);
  assert.equal(typeof state.lastDailyAt, "number");
  assert.equal(typeof state.createdAt, "number");
});

test("1bis. Date nullable (lastDailyAt) geree correctement quand null", () => {
  const state = toPlayerState(buildRecord({ player: { lastDailyAt: null } as never }));
  assert.equal(state.lastDailyAt, null);
});

test("2. plots reconstruits dans le meme ordre/correspondance d'index que recu", () => {
  const state = toPlayerState(buildRecord());
  assert.equal(state.plots.length, 2);
  assert.equal(state.plots[0]!.cropId, null);
  assert.equal(state.plots[1]!.cropId, "carrot");
  assert.equal(state.plots[1]!.plantedAt, 1_700_050_000_000);
});

test("3. inventory_items convertis en objet inventory (itemId -> quantity)", () => {
  const state = toPlayerState(buildRecord());
  assert.deepEqual(state.inventory, { wheat: 5, bread: 2 });
  assert.equal(Object.keys(state.inventory).length, 2);
});

test("3bis. inventory vide quand aucune ligne inventory_items", () => {
  const state = toPlayerState(buildRecord({ inventoryItems: [] }));
  assert.deepEqual(state.inventory, {});
});

test("4. quests conservees telles quelles (memes valeurs, aucune perte)", () => {
  const state = toPlayerState(buildRecord());
  assert.deepEqual(state.quests, [
    { type: "harvest", label: "Recolter 10 cultures", target: 10, progress: 4, rewardCoins: 40, claimed: false },
  ]);
});

test("5. unlockedSkins conserve tel quel", () => {
  const state = toPlayerState(buildRecord());
  assert.deepEqual(state.unlockedSkins, ["classic", "autumn"]);
});

test("6. cropId nullable correctement gere (plot vide -> null, pas undefined)", () => {
  const state = toPlayerState(buildRecord());
  assert.equal(state.plots[0]!.cropId, null);
  assert.notEqual(state.plots[0]!.cropId, undefined);
});

test("7. toutes les proprietes de PlayerState presentes avec les bonnes valeurs", () => {
  const state = toPlayerState(buildRecord());
  assert.deepStrictEqual(state, {
    userId: "user-1",
    coins: 120,
    level: 3,
    xp: 42,
    plots: [
      { cropId: null, plantedAt: null, notifiedReady: false },
      { cropId: "carrot", plantedAt: 1_700_050_000_000, notifiedReady: false },
    ],
    inventory: { wheat: 5, bread: 2 },
    irrigationLevel: 2,
    fertilizerLevel: 1,
    lastDailyAt: 1_700_000_000_000,
    autoReplant: true,
    weeklySnapshotCoins: 100,
    createdAt: 1_699_000_000_000,
    updatedAt: 1_700_200_000_000,
    totalHarvested: 57,
    quests: [
      { type: "harvest", label: "Recolter 10 cultures", target: 10, progress: 4, rewardCoins: 40, claimed: false },
    ],
    questsResetAt: 1_700_100_000_000,
    plotSkin: "autumn",
    unlockedSkins: ["classic", "autumn"],
    weatherForecast: "rain",
  });
});

test("7bis. weatherForecast nullable gere correctement quand null", () => {
  const state = toPlayerState(buildRecord({ player: { weatherForecast: null } as never }));
  assert.equal(state.weatherForecast, null);
});
