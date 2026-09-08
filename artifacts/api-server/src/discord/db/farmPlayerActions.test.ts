// Tests de farmPlayerActions.ts (LOT 2 -- mutations joueur simples).
// Aucune connexion PostgreSQL : mutatePlayer/getGlobalState sont mockes
// via FarmPlayerActionsDeps (meme convention que FarmRepositoryDeps/
// PlayerWriteDeps/MutatePlayerDeps dans farmRepository.test.ts). Le mock
// de mutatePlayer applique reellement le mutator recu a un PlayerState en
// memoire -- ce qui exerce les VRAIES fonctions metier de farm.ts (plant,
// buyUpgrade, craft, claimDaily, claimQuest, chooseSkin,
// toggleAutoReplant, buyWeatherForecast), preuve qu'aucune regle n'est
// dupliquee/reecrite dans farmPlayerActions.ts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import { FarmError } from "../farm.ts";
import {
  buyPlayerUpgrade,
  buyPlayerWeatherForecast,
  choosePlayerSkin,
  claimPlayerDaily,
  claimPlayerQuest,
  craftPlayerItem,
  harvestPlayerCrops,
  plantPlayerCrop,
  sellPlayerItems,
  togglePlayerAutoReplant,
  type FarmPlayerActionsDeps,
  type HarvestPlayerActionsDeps,
  type SellPlayerItemsDeps,
} from "./farmPlayerActions.ts";
import type { GlobalState, PlayerState } from "../types";

const NOW = 1_700_000_000_000;
const TEST_PLAYER_ID = "v2-test-player-001";

function buildPlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    userId: TEST_PLAYER_ID,
    coins: 200,
    level: 10,
    xp: 0,
    plots: [
      { cropId: null, plantedAt: null, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
    ],
    inventory: { wheat: 0 },
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: 200,
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

// Mock de mutatePlayer qui applique REELLEMENT le mutator recu au
// PlayerState fourni (mutation en place, meme contrat que le vrai
// mutatePlayer()) -- pas une simple factice qui ignore son argument.
function buildMutatePlayerMock(player: PlayerState) {
  return mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void | Promise<void>) => {
    await mutator(player);
    return player;
  });
}

function buildDeps(
  player: PlayerState,
  overrides: { getGlobalState?: ReturnType<typeof mock.fn<() => Promise<GlobalState | null>>> } = {},
): {
  deps: FarmPlayerActionsDeps;
  mutatePlayer: ReturnType<typeof buildMutatePlayerMock>;
  getGlobalState: ReturnType<typeof mock.fn<() => Promise<GlobalState | null>>>;
} {
  const mutatePlayerMock = buildMutatePlayerMock(player);
  const getGlobalStateMock = overrides.getGlobalState ?? mock.fn(async () => null as GlobalState | null);
  const deps: FarmPlayerActionsDeps = {
    mutatePlayer: mutatePlayerMock as unknown as FarmPlayerActionsDeps["mutatePlayer"],
    getGlobalState: getGlobalStateMock as unknown as FarmPlayerActionsDeps["getGlobalState"],
  };
  return { deps, mutatePlayer: mutatePlayerMock, getGlobalState: getGlobalStateMock };
}

// ===========================================================================
// plantPlayerCrop
// ===========================================================================

test("plantPlayerCrop : mutatePlayer appele avec le bon playerId, plant() appliquee, numero de parcelle retourne", async () => {
  const player = buildPlayerState();
  const { deps, mutatePlayer } = buildDeps(player);

  const plotNumber = await plantPlayerCrop(TEST_PLAYER_ID, "wheat", null, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(plotNumber, 1);
  assert.equal(player.plots[0]?.cropId, "wheat");
  assert.equal(player.coins, 195); // 200 - seedCost(wheat)=5
});

test("plantPlayerCrop : erreur metier (culture non debloquee) propagee telle quelle", async () => {
  const player = buildPlayerState({ level: 1 });
  const { deps } = buildDeps(player);

  await assert.rejects(
    () => plantPlayerCrop(TEST_PLAYER_ID, "potato", null, deps), // unlockLevel potato = 5
    (error: unknown) => error instanceof FarmError && /se débloque au niveau/.test(error.message),
  );
});

// ===========================================================================
// buyPlayerUpgrade
// ===========================================================================

test("buyPlayerUpgrade : mutatePlayer appele avec le bon playerId, buyUpgrade() appliquee, resultat retourne", async () => {
  // 4 parcelles (STARTING_PLOTS) : cout de la 5e = round(120 * 1.55^0) = 120.
  const player = buildPlayerState({
    coins: 200,
    plots: Array.from({ length: 4 }, () => ({ cropId: null, plantedAt: null, notifiedReady: false })),
  });
  const { deps, mutatePlayer } = buildDeps(player);

  const result = await buyPlayerUpgrade(TEST_PLAYER_ID, "plots", 1, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(result.bought, 1);
  assert.equal(result.spent, 120);
  assert.equal(player.plots.length, 5);
});

test("buyPlayerUpgrade : erreur metier (pieces insuffisantes) propagee telle quelle", async () => {
  const player = buildPlayerState({ coins: 0 });
  const { deps } = buildDeps(player);

  await assert.rejects(
    () => buyPlayerUpgrade(TEST_PLAYER_ID, "plots", 1, deps),
    (error: unknown) => error instanceof FarmError && /Achat impossible/.test(error.message),
  );
});

// ===========================================================================
// craftPlayerItem
// ===========================================================================

test("craftPlayerItem : mutatePlayer appele avec le bon playerId, craft() appliquee, quantite retournee", async () => {
  const player = buildPlayerState({ inventory: { wheat: 3 } });
  const { deps, mutatePlayer } = buildDeps(player);

  const crafted = await craftPlayerItem(TEST_PLAYER_ID, "bread", 1, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(crafted, 1);
  assert.equal(player.inventory.wheat, 0);
  assert.equal(player.inventory.bread, 1);
});

test("craftPlayerItem : erreur metier (ingredients insuffisants) propagee telle quelle", async () => {
  const player = buildPlayerState({ inventory: { wheat: 1 } });
  const { deps } = buildDeps(player);

  await assert.rejects(
    () => craftPlayerItem(TEST_PLAYER_ID, "bread", 1, deps),
    (error: unknown) => error instanceof FarmError && /pas assez de cultures/.test(error.message),
  );
});

// ===========================================================================
// claimPlayerDaily
// ===========================================================================

test("claimPlayerDaily : mutatePlayer appele avec le bon playerId, claimDaily() appliquee, recompense retournee", async () => {
  const player = buildPlayerState({ level: 10, lastDailyAt: null });
  const { deps, mutatePlayer } = buildDeps(player);

  const reward = await claimPlayerDaily(TEST_PLAYER_ID, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(reward, 60); // 40 + level(10)*2
  assert.ok(typeof player.lastDailyAt === "number"); // lastDailyAt mis a jour par claimDaily()
});

test("claimPlayerDaily : erreur metier (cooldown actif) propagee telle quelle", async () => {
  const player = buildPlayerState({ lastDailyAt: Date.now() });
  const { deps } = buildDeps(player);

  await assert.rejects(
    () => claimPlayerDaily(TEST_PLAYER_ID, deps),
    (error: unknown) => error instanceof FarmError && /revient dans environ/.test(error.message),
  );
});

// ===========================================================================
// claimPlayerQuest
// ===========================================================================

test("claimPlayerQuest : mutatePlayer appele avec le bon playerId, claimQuest() appliquee, recompense retournee", async () => {
  const player = buildPlayerState({
    quests: [{ type: "harvest", label: "Récolter 10 cultures", target: 10, progress: 10, rewardCoins: 40, claimed: false }],
  });
  const { deps, mutatePlayer } = buildDeps(player);

  const reward = await claimPlayerQuest(TEST_PLAYER_ID, 0, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(reward, 40);
  assert.equal(player.quests[0]?.claimed, true);
});

test("claimPlayerQuest : erreur metier (quete non terminee) propagee telle quelle", async () => {
  const player = buildPlayerState({
    quests: [{ type: "harvest", label: "Récolter 10 cultures", target: 10, progress: 3, rewardCoins: 40, claimed: false }],
  });
  const { deps } = buildDeps(player);

  await assert.rejects(
    () => claimPlayerQuest(TEST_PLAYER_ID, 0, deps),
    (error: unknown) => error instanceof FarmError && /pas encore terminée/.test(error.message),
  );
});

// ===========================================================================
// choosePlayerSkin
// ===========================================================================

test("choosePlayerSkin : mutatePlayer appele avec le bon playerId, chooseSkin() appliquee, PlayerState complet retourne", async () => {
  const player = buildPlayerState({ level: 8 });
  const { deps, mutatePlayer } = buildDeps(player);

  const result = await choosePlayerSkin(TEST_PLAYER_ID, "autumn", deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(result.plotSkin, "autumn");
  assert.deepEqual(result.unlockedSkins, ["classic", "autumn"]);
  assert.equal(result, player); // meme instance que celle mutee par mutatePlayer
});

test("choosePlayerSkin : erreur metier (theme non debloque) propagee telle quelle", async () => {
  const player = buildPlayerState({ level: 1 });
  const { deps } = buildDeps(player);

  await assert.rejects(
    () => choosePlayerSkin(TEST_PLAYER_ID, "autumn", deps),
    (error: unknown) => error instanceof FarmError && /se débloque au niveau/.test(error.message),
  );
});

// ===========================================================================
// togglePlayerAutoReplant
// ===========================================================================

test("togglePlayerAutoReplant : mutatePlayer appele avec le bon playerId, toggleAutoReplant() appliquee, nouvelle valeur retournee", async () => {
  const player = buildPlayerState({ autoReplant: false });
  const { deps, mutatePlayer } = buildDeps(player);

  const result = await togglePlayerAutoReplant(TEST_PLAYER_ID, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(result, true);
  assert.equal(player.autoReplant, true);
});

test("togglePlayerAutoReplant : un second appel bascule a nouveau (aucune erreur metier possible pour cette action)", async () => {
  const player = buildPlayerState({ autoReplant: true });
  const { deps } = buildDeps(player);

  const result = await togglePlayerAutoReplant(TEST_PLAYER_ID, deps);

  assert.equal(result, false);
});

// ===========================================================================
// buyPlayerWeatherForecast -- seule action de ce fichier qui lit
// global_state (jamais ne l'ecrit).
// ===========================================================================

test("buyPlayerWeatherForecast : getGlobalState lu, mutatePlayer appele avec le bon playerId, buyWeatherForecast() appliquee, prevision retournee", async () => {
  const player = buildPlayerState({ coins: 200 });
  const global = buildGlobalState({ nextWeatherType: "pests" });
  const globalBeforeCall = { ...global };
  const { deps, mutatePlayer, getGlobalState: getGlobalStateMock } = buildDeps(player, {
    getGlobalState: mock.fn(async () => global as GlobalState | null),
  });

  const forecast = await buyPlayerWeatherForecast(TEST_PLAYER_ID, deps);

  assert.equal(getGlobalStateMock.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(mutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(forecast, "pests");
  assert.equal(player.weatherForecast, "pests");
  assert.equal(player.coins, 185); // 200 - FORECAST_COST(15)
  // Preuve qu'aucune mutation de global_state n'a eu lieu : l'objet global
  // recu de getGlobalState() est rigoureusement identique avant/apres.
  assert.deepEqual(global, globalBeforeCall);
});

test("buyPlayerWeatherForecast : erreur metier (pieces insuffisantes) propagee telle quelle, aucune mutation joueur", async () => {
  const player = buildPlayerState({ coins: 0 });
  const global = buildGlobalState();
  const { deps, mutatePlayer } = buildDeps(player, {
    getGlobalState: mock.fn(async () => global as GlobalState | null),
  });

  await assert.rejects(
    () => buyPlayerWeatherForecast(TEST_PLAYER_ID, deps),
    (error: unknown) => error instanceof FarmError && /Il te faut/.test(error.message),
  );
  assert.equal(mutatePlayer.mock.calls.length, 1); // mutatePlayer est bien entre, l'erreur vient du mutator
  assert.equal(player.weatherForecast, null); // jamais ecrit
});

test("buyPlayerWeatherForecast : global_state absent -> FarmError explicite, mutatePlayer jamais appele", async () => {
  const player = buildPlayerState();
  const { deps, mutatePlayer } = buildDeps(player);

  await assert.rejects(
    () => buyPlayerWeatherForecast(TEST_PLAYER_ID, deps),
    (error: unknown) => error instanceof FarmError && /introuvable/.test(error.message),
  );
  assert.equal(mutatePlayer.mock.calls.length, 0);
});

// ===========================================================================
// Garanties transversales du LOT 2
// ===========================================================================

test("deux actions independantes (plant, craft) passent bien exclusivement par mutatePlayer, jamais par getGlobalState", async () => {
  const player = buildPlayerState({ inventory: { wheat: 3 } });
  const { deps, mutatePlayer, getGlobalState: getGlobalStateMock } = buildDeps(player);

  await plantPlayerCrop(TEST_PLAYER_ID, "wheat", 2, deps);
  await craftPlayerItem(TEST_PLAYER_ID, "bread", 1, deps);

  assert.equal(mutatePlayer.mock.calls.length, 2);
  assert.equal(mutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(mutatePlayer.mock.calls[1]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(getGlobalStateMock.mock.calls.length, 0);
});

// ===========================================================================
// harvestPlayerCrops (LOT 6) -- mutatePlayerAndGlobal(), pas mutatePlayer().
// Mock qui applique REELLEMENT le mutator (player, global) recu, meme
// contrat que buildMutatePlayerMock ci-dessus mais pour les DEUX
// ressources -- exerce la VRAIE fonction harvest() de farm.ts.
// ===========================================================================

function buildMutatePlayerAndGlobalMock(player: PlayerState, global: GlobalState) {
  return mock.fn(async (_playerId: string, mutator: (p: PlayerState, g: GlobalState) => void | Promise<void>) => {
    await mutator(player, global);
    return { player, global };
  });
}

function buildHarvestDeps(
  player: PlayerState,
  global: GlobalState,
): { deps: HarvestPlayerActionsDeps; mutatePlayerAndGlobal: ReturnType<typeof buildMutatePlayerAndGlobalMock> } {
  const mutatePlayerAndGlobalMock = buildMutatePlayerAndGlobalMock(player, global);
  const deps: HarvestPlayerActionsDeps = {
    mutatePlayerAndGlobal: mutatePlayerAndGlobalMock as unknown as HarvestPlayerActionsDeps["mutatePlayerAndGlobal"],
  };
  return { deps, mutatePlayerAndGlobal: mutatePlayerAndGlobalMock };
}

test("harvestPlayerCrops : mutatePlayerAndGlobal appele avec le bon playerId, harvest() appliquee, HarvestResult + GlobalState retournes", async () => {
  const player = buildPlayerState({
    plots: [{ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false }],
    inventory: {},
  });
  const global = buildGlobalState();
  const { deps, mutatePlayerAndGlobal } = buildHarvestDeps(player, global);

  const { result, global: returnedGlobal } = await harvestPlayerCrops(TEST_PLAYER_ID, deps);

  assert.equal(mutatePlayerAndGlobal.mock.calls.length, 1);
  assert.equal(mutatePlayerAndGlobal.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(result.harvested.length, 1);
  assert.equal(result.harvested[0]!.cropId, "wheat");
  assert.equal(returnedGlobal, global, "le GlobalState retourne doit etre celui reellement mute par harvest()");
  assert.ok((player.inventory.wheat ?? 0) > 0, "l'inventaire doit avoir ete incremente par le vrai harvest()");
});

test("harvestPlayerCrops : aucune parcelle prete => harvested vide, AUCUNE erreur levee ici (le controle vit dans presenters.ts, comme en V1)", async () => {
  const player = buildPlayerState({ plots: [{ cropId: null, plantedAt: null, notifiedReady: false }] });
  const global = buildGlobalState();
  const { deps } = buildHarvestDeps(player, global);

  const { result } = await harvestPlayerCrops(TEST_PLAYER_ID, deps);

  assert.deepEqual(result.harvested, []);
});

test("harvestPlayerCrops : la progression du defi quotidien (daily_challenge) est mise a jour par le MEME harvest(), aucune regle dupliquee", async () => {
  const player = buildPlayerState({
    plots: [{ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false }],
  });
  const global = buildGlobalState({
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
  });
  const { deps } = buildHarvestDeps(player, global);

  await harvestPlayerCrops(TEST_PLAYER_ID, deps);

  assert.ok(global.dailyChallenge.progress > 0, "la progression du defi doit avoir avance (meme regle que harvest() V1)");
  assert.ok(global.dailyChallenge.contributors.includes(TEST_PLAYER_ID));
});

// ===========================================================================
// sellPlayerItems (LOT 6) -- meme primitive mutatePlayerAndGlobal() que
// harvestPlayerCrops ci-dessus, meme mock reutilise.
// ===========================================================================

function buildSellDeps(
  player: PlayerState,
  global: GlobalState,
): { deps: SellPlayerItemsDeps; mutatePlayerAndGlobal: ReturnType<typeof buildMutatePlayerAndGlobalMock> } {
  const mutatePlayerAndGlobalMock = buildMutatePlayerAndGlobalMock(player, global);
  const deps: SellPlayerItemsDeps = {
    mutatePlayerAndGlobal: mutatePlayerAndGlobalMock as unknown as SellPlayerItemsDeps["mutatePlayerAndGlobal"],
  };
  return { deps, mutatePlayerAndGlobal: mutatePlayerAndGlobalMock };
}

test("sellPlayerItems : mutatePlayerAndGlobal appele avec le bon playerId, sell() appliquee (inventaire diminue, coins augmentes), SellResult + GlobalState retournes", async () => {
  const player = buildPlayerState({ inventory: { wheat: 10 }, coins: 0 });
  const global = buildGlobalState({ marketMultiplier: 1, contract: { cropId: "carrot", required: 20, remaining: 20, bonusMultiplier: 1.6, renewedAt: NOW } });
  const { deps, mutatePlayerAndGlobal } = buildSellDeps(player, global);

  const { result, global: returnedGlobal } = await sellPlayerItems(TEST_PLAYER_ID, "wheat", 5, deps);

  assert.equal(mutatePlayerAndGlobal.mock.calls.length, 1);
  assert.equal(mutatePlayerAndGlobal.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(result.sold.length, 1);
  assert.equal(player.inventory.wheat, 5);
  assert.ok(player.coins > 0, "les coins doivent avoir augmente (vrai sell())");
  assert.equal(returnedGlobal, global, "le GlobalState retourne doit etre celui reellement mute par sell()");
});

test("sellPlayerItems : le bonus de contrat exact V1 est applique et contract.remaining mis a jour par le MEME sell(), aucune regle dupliquee", async () => {
  const player = buildPlayerState({ inventory: { wheat: 10 }, coins: 0 });
  const global = buildGlobalState({
    marketMultiplier: 1,
    contract: { cropId: "wheat", required: 20, remaining: 6, bonusMultiplier: 1.6, renewedAt: NOW },
  });
  const { deps } = buildSellDeps(player, global);

  const { result } = await sellPlayerItems(TEST_PLAYER_ID, "wheat", 10, deps);

  // basePrice(wheat)=4, marketMultiplier=1 => normalPrice=4 ; bonus/unite =
  // round(4*1.6)=6 ; 6 unites contractees*6 + 4 unites*4 = 36+16 = 52 --
  // meme regle V1 exacte que sell() dans farm.ts.
  assert.equal(result.earned, 52);
  assert.equal(global.contract.remaining, 0);
});

test("sellPlayerItems : aucune ressource a vendre => FarmError propagee telle quelle", async () => {
  const player = buildPlayerState({ inventory: {} });
  const global = buildGlobalState();
  const { deps } = buildSellDeps(player, global);

  await assert.rejects(() => sellPlayerItems(TEST_PLAYER_ID, "wheat", null, deps), FarmError);
});

test("farmPlayerActions.ts n'importe ni FarmStore/getFarmStore, ni store.ts/sharedStore.ts ; mutatePlayerAndGlobal (harvestPlayerCrops) ET mutateGlobalState (enrichGlobalStateInPostgres, bouton codex 'Actualiser') sont desormais toutes deux attendues -- LOT 6", async () => {
  const filePath = new URL("./farmPlayerActions.ts", import.meta.url);
  const source = await readFile(filePath, "utf8");
  // Seules les lignes d'import (et non les commentaires explicatifs) sont
  // examinees.
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line))
    .join("\n");

  assert.ok(!/FarmStore/.test(importLines), "aucun import de FarmStore attendu");
  assert.ok(!/getFarmStore/.test(importLines), "aucun import de getFarmStore attendu");
  assert.ok(!/from ["']\.\/store/.test(importLines), "aucun import de ./store attendu");
  assert.ok(!/from ["']\.\/sharedStore/.test(importLines), "aucun import de ./sharedStore attendu");
  assert.ok(/mutatePlayerAndGlobal/.test(importLines), "mutatePlayerAndGlobal DOIT desormais etre importe (harvestPlayerCrops, LOT 6)");
  assert.ok(/mutateGlobalState/.test(importLines), "mutateGlobalState DOIT desormais etre importe (enrichGlobalStateInPostgres, bouton codex 'Actualiser', LOT 6)");
});
