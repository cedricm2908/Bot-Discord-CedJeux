// Tests dedies a harvest() (../farm.ts) -- fonction pure, sans DB ni
// Discord, testable directement avec des fixtures PlayerState/GlobalState
// minimales. Couvre specifiquement le bug rendement fractionnaire
// (weatherMultiplier non-entier x baseYield) confirme par l'audit read-only
// precedent : PostgreSQL rejette des colonnes integer (total_harvested,
// inventory_items.quantity, daily_challenge.progress) recevant une valeur
// comme 3.75, alors que le JSON V1 l'acceptait silencieusement.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harvest } from "./farm.ts";
import { CROPS, defaultGlobalState } from "./constants.ts";
import type { GlobalState, PlayerState, Plot, QuestProgress } from "./types";

const NOW = 1_700_000_000_000;
const WHEAT = CROPS.find((crop) => crop.id === "wheat")!;

function buildPlot(overrides: Partial<Plot> = {}): Plot {
  return { cropId: null, plantedAt: null, notifiedReady: false, ...overrides };
}

function buildPlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    userId: "test-player",
    coins: 50,
    level: 1,
    xp: 0,
    plots: [],
    inventory: {},
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: 50,
    createdAt: NOW,
    updatedAt: NOW,
    totalHarvested: 0,
    quests: [],
    questsResetAt: NOW,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: null,
    ...overrides,
  };
}

function buildGlobalState(overrides: Partial<GlobalState> = {}): GlobalState {
  return {
    ...defaultGlobalState(NOW),
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

function harvestQuest(overrides: Partial<QuestProgress> = {}): QuestProgress {
  return { type: "harvest", label: "Récolter 10 cultures", target: 10, progress: 0, rewardCoins: 40, claimed: false, ...overrides };
}

// ===========================================================================
// CAS A -- meteo pluie (weatherMultiplier = 1.25)
// ===========================================================================

test("harvest() CAS A (pluie x1.25) : wheat baseYield=3, fertilizerLevel=0 -> amount=4 (entier), jamais 3.75", () => {
  assert.equal(WHEAT.baseYield, 3, "precondition : baseYield de wheat suppose etre 3");
  const plot = buildPlot({ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const player = buildPlayerState({
    plots: [plot],
    quests: [harvestQuest()],
  });
  const global = buildGlobalState({ weather: "rain", weatherMultiplier: 1.25 });

  const result = harvest(player, global, NOW);

  assert.equal(result.harvested.length, 1);
  const { amount } = result.harvested[0]!;
  assert.equal(amount, 4, "Math.round(3 * 1 * 1.25) = Math.round(3.75) = 4");
  assert.ok(Number.isInteger(amount), "amount doit toujours etre un entier");

  assert.equal(player.inventory.wheat, 4, "inventory doit augmenter EXACTEMENT du meme montant entier");
  assert.ok(Number.isInteger(player.inventory.wheat), "inventory quantity doit rester compatible avec la colonne integer Postgres");

  assert.equal(player.totalHarvested, 4, "totalHarvested doit augmenter EXACTEMENT du meme montant entier");
  assert.ok(Number.isInteger(player.totalHarvested), "totalHarvested doit rester compatible avec la colonne integer Postgres");

  assert.equal(global.dailyChallenge.progress, 4, "le defi quotidien (wheat, actif) doit progresser du meme montant entier");
  assert.ok(Number.isInteger(global.dailyChallenge.progress), "daily_challenge.progress doit rester compatible avec la colonne integer Postgres");

  assert.equal(player.quests[0]!.progress, 4, "la quete harvest active doit progresser du meme montant entier");
  assert.ok(Number.isInteger(player.quests[0]!.progress), "quest progress doit rester un entier (coherence gameplay, meme si jsonb cote DB)");
});

// ===========================================================================
// CAS B -- meteo nuisibles (weatherMultiplier = 0.75)
// ===========================================================================

test("harvest() CAS B (nuisibles x0.75) : rendement arrondi via Math.round() et reste >= 1", () => {
  // wheat baseYield=3, fertilizerLevel=0 : 3 * 1 * 0.75 = 2.25 -> round -> 2.
  const plot = buildPlot({ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const player = buildPlayerState({ plots: [plot] });
  const global = buildGlobalState({ weather: "pests", weatherMultiplier: 0.75 });

  const result = harvest(player, global, NOW);

  const { amount } = result.harvested[0]!;
  assert.equal(amount, 2, "Math.round(3 * 1 * 0.75) = Math.round(2.25) = 2");
  assert.ok(Number.isInteger(amount));
  assert.ok(amount >= 1, "Math.max(1, ...) doit garantir un minimum de 1 meme avec un multiplicateur reducteur");
});

test("harvest() CAS B bis (nuisibles x0.75, tres faible rendement) : Math.max(1, ...) empeche un rendement nul ou negatif", () => {
  // Un crop dont le rendement ajuste x0.75 arrondirait sous 1 doit rester a 1.
  const plot = buildPlot({ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  // fertilizerLevel tres negatif est impossible en jeu (jamais < 0, contrainte
  // SQL players_fertilizer_level_non_negative) -- le plancher Math.max(1, ...)
  // est donc verifie ici via un weatherMultiplier extreme plutot qu'un
  // fertilizerLevel invalide, pour rester dans un etat de jeu atteignable.
  const player = buildPlayerState({ plots: [plot] });
  const global = buildGlobalState({ weather: "pests", weatherMultiplier: 0.1 });

  const result = harvest(player, global, NOW);

  const { amount } = result.harvested[0]!;
  assert.equal(amount, 1, "Math.round(3 * 1 * 0.1) = Math.round(0.3) = 0, releve a 1 par Math.max(1, ...)");
  assert.ok(Number.isInteger(amount));
});

// ===========================================================================
// CAS C -- meteo normale (weatherMultiplier = 1), non-regression
// ===========================================================================

test("harvest() CAS C (meteo normale x1) : rendement identique a l'ancienne formule, aucune regression", () => {
  // A weatherMultiplier=1, ancienne formule = Math.round(3*(1+0)) * 1 = 3.
  // Nouvelle formule = Math.round(3*(1+0)*1) = 3. Memes deux formules
  // doivent coincider EXACTEMENT quand weatherMultiplier=1 (le cas testé
  // par tous les tests harvest existants dans le reste du repo).
  const plot = buildPlot({ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const player = buildPlayerState({ plots: [plot], fertilizerLevel: 4 });
  const global = buildGlobalState({ weather: "normal", weatherMultiplier: 1 });

  const result = harvest(player, global, NOW);

  const { amount } = result.harvested[0]!;
  // baseYield 3 * (1 + 4*0.05) = 3*1.2 = 3.6 -> round -> 4, identique avant/apres.
  assert.equal(amount, 4);
  assert.ok(Number.isInteger(amount));
});
