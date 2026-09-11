// MISSION QA AUTONOME -- Parcours joueur complet de bout en bout pour
// l'Activity Farm2Win, pour un joueur Postgres-allowliste UNIQUEMENT.
//
// A LA DIFFERENCE de activity.test.ts (qui mocke chaque primitive
// individuellement, route par route), ce fichier fait tourner les VRAIES
// fonctions de ../discord/db/farmPlayerActions.ts (plantPlayerCrop,
// harvestPlayerCrops, sellPlayerItems, buyPlayerUpgrade, craftPlayerItem,
// claimPlayerDaily, claimPlayerQuest, choosePlayerSkin,
// buyPlayerWeatherForecast, togglePlayerAutoReplant) -- donc les VRAIES
// regles metier de ../discord/farm.ts (prix, XP, formules d'upgrade,
// cout des graines, etc.) s'executent reellement, contre un faux "stockage
// Postgres" en memoire (un seul PlayerState + un seul GlobalState mutables,
// partages entre TOUTES les etapes du parcours) qui simule
// mutatePlayer()/mutatePlayerAndGlobal()/getGlobalState() sans jamais
// toucher Neon/Railway.
//
// Chaque etape suit exactement le schema demande par la mission QA :
//   etat avant -> action (resolveActivityXxx) -> reponse
//   -> GET /activity/me (resolveActivityMe) -> etat apres
// et verifie que la reponse de l'action ET la relecture /me retournent
// EXACTEMENT le meme etat (aucune divergence entre les deux, exactement
// le bug qui causait la desynchronisation plot-render corrigee par les
// LOTs ACTIVITY-PG1..PG4).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveActivityAutoreplant,
  resolveActivityBuy,
  resolveActivityCraft,
  resolveActivityDaily,
  resolveActivityForecast,
  resolveActivityHarvest,
  resolveActivityMe,
  resolveActivityPlant,
  resolveActivityQuestClaim,
  resolveActivitySell,
  resolveActivitySkin,
  type ActivityAutoreplantDeps,
  type ActivityBuyDeps,
  type ActivityCraftDeps,
  type ActivityDailyDeps,
  type ActivityForecastDeps,
  type ActivityHarvestDeps,
  type ActivityMeDeps,
  type ActivityPlantDeps,
  type ActivityQuestClaimDeps,
  type ActivitySellDeps,
  type ActivitySkinDeps,
  type DiscordUser,
} from "./activity.ts";
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
} from "../discord/db/farmPlayerActions.ts";
import { WEATHER_INFO } from "../discord/constants.ts";
import type { FarmStore } from "../discord/store";
import type { CropId, GlobalState, InventoryId, PlayerState, PlotSkinId, ProductId } from "../discord/types";

const TEST_PLAYER_ID = "v2-journey-player-001";
const DISCORD_USER: DiscordUser = { id: TEST_PLAYER_ID, username: "journey-tester" };

// "store" JSON qui ne doit JAMAIS etre touche de tout le parcours -- le
// joueur est allowliste sur toute la duree du test, donc chaque appel
// mutatePlayer() de ce store constitue un bug de repli silencieux vers le
// JSON s'il est jamais invoque.
const poisonedJsonStore: FarmStore = {
  mutatePlayer: () => {
    throw new Error("store.mutatePlayer (JSON) ne doit JAMAIS etre appele -- joueur allowliste sur tout le parcours");
  },
  getPlayer: () => {
    throw new Error("store.getPlayer (JSON) ne doit JAMAIS etre appele -- joueur allowliste sur tout le parcours");
  },
  save: async () => {
    throw new Error("store.save (JSON) ne doit JAMAIS etre appele -- joueur allowliste sur tout le parcours");
  },
  global: undefined as unknown as GlobalState,
} as unknown as FarmStore;

test("PLAYER JOURNEY -- parcours complet Activity Farm2Win PostgreSQL (plant -> harvest -> sell -> buy -> craft -> daily -> quest -> autoreplant -> skin -> forecast), coherent de bout en bout", async () => {
  const journeyNow = Date.now();

  // "Table Postgres" en memoire : UN SEUL PlayerState + UN SEUL
  // GlobalState mutables, partages par toutes les etapes -- exactement
  // comme une vraie ligne verrouillee/relue par mutatePlayer()/
  // mutatePlayerAndGlobal() cote Postgres.
  const dbPlayer: PlayerState = {
    userId: TEST_PLAYER_ID,
    coins: 1000,
    level: 10,
    xp: 0,
    plots: [
      { cropId: null, plantedAt: null, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
    ],
    inventory: {},
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: 1000,
    createdAt: journeyNow,
    updatedAt: journeyNow,
    totalHarvested: 0,
    quests: [
      { type: "harvest", label: "Récolter des cultures", target: 1, progress: 1, rewardCoins: 50, claimed: false },
    ],
    questsResetAt: journeyNow,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: null,
  };

  const dbGlobal: GlobalState = {
    marketMultiplier: 1,
    previousMarketMultiplier: 1,
    marketUpdatedAt: journeyNow,
    weather: "normal",
    weatherMultiplier: 1,
    weatherChangedAt: null,
    weatherExpiresAt: null,
    nextWeatherAt: journeyNow,
    nextWeatherType: "rain",
    contract: { cropId: "carrot", required: 20, remaining: 20, bonusMultiplier: 1.6, renewedAt: journeyNow },
    weeklyStartedAt: journeyNow,
    dailyChallenge: {
      cropId: "potato",
      target: 200,
      progress: 0,
      contributors: [],
      rewardCoins: 80,
      startedAt: journeyNow,
      completed: false,
      rewarded: false,
    },
  };

  // Fausses primitives bas niveau -- simulent mutatePlayer()/
  // mutatePlayerAndGlobal()/getGlobalState() (farmRepository.ts) en
  // appliquant le mutator directement sur dbPlayer/dbGlobal, sans jamais
  // toucher Neon/Railway. Les VRAIES fonctions de farmPlayerActions.ts
  // (importees plus haut, jamais mockees) sont appelees avec CES deps --
  // donc les VRAIES regles de farm.ts (plant/harvest/sell/buyUpgrade/
  // craft/claimDaily/claimQuest/chooseSkin/buyWeatherForecast/
  // toggleAutoReplant) s'executent reellement a chaque etape.
  async function fakeMutatePlayer(
    _playerId: string,
    mutator: (player: PlayerState) => void | Promise<void>,
  ): Promise<PlayerState> {
    await mutator(dbPlayer);
    return dbPlayer;
  }
  async function fakeMutatePlayerAndGlobal(
    _playerId: string,
    mutator: (player: PlayerState, global: GlobalState) => void | Promise<void>,
  ): Promise<{ player: PlayerState; global: GlobalState }> {
    await mutator(dbPlayer, dbGlobal);
    return { player: dbPlayer, global: dbGlobal };
  }
  async function fakeGetGlobalState(): Promise<GlobalState | null> {
    return dbGlobal;
  }
  async function fakeGetPlayer(_playerId: string): Promise<PlayerState | null> {
    return dbPlayer;
  }
  async function fakeEnsurePlayerExists(_playerId: string) {
    return { player: dbPlayer, created: false };
  }
  const shouldUsePostgresRuntime = () => true;
  const requireDiscordUser = async (_authHeader: string | undefined) => DISCORD_USER;
  const getFarmStore = async () => poisonedJsonStore;

  // Deps communs a toutes les routes -- meme structure que
  // realActivityXxxDeps dans activity.ts, mais pointant vers nos fausses
  // primitives bas niveau au lieu de Neon/Railway.
  const commonDeps = {
    requireDiscordUser,
    getFarmStore,
    shouldUsePostgresRuntime,
    ensurePlayerExists: fakeEnsurePlayerExists,
    getPlayer: fakeGetPlayer,
    getGlobalState: fakeGetGlobalState,
  };

  // IMPORTANT : chaque primitive reelle de farmPlayerActions.ts accepte un
  // parametre `deps` optionnel qui, si omis, retombe sur SES PROPRES
  // dependances par defaut (mutatePlayer/mutatePlayerAndGlobal/
  // getGlobalState REELS de farmRepository.ts -- donc Neon/Railway). Les
  // routes resolveActivityXxx() appellent toujours `deps.xxxPlayerYyy(...)`
  // SANS argument `deps` supplementaire (exactement comme en production) --
  // il faut donc lier explicitement nos fausses primitives bas niveau ICI,
  // via ces wrappers, plutot que de passer les fonctions reelles telles
  // quelles (ce qui declencherait une VRAIE tentative de connexion
  // Postgres).
  const journeyPlantPlayerCrop = (playerId: string, cropId: CropId, requestedPlot: number | null) =>
    plantPlayerCrop(playerId, cropId, requestedPlot, { mutatePlayer: fakeMutatePlayer, getGlobalState: fakeGetGlobalState });
  const journeyHarvestPlayerCrops = (playerId: string) =>
    harvestPlayerCrops(playerId, { mutatePlayerAndGlobal: fakeMutatePlayerAndGlobal });
  const journeySellPlayerItems = (playerId: string, itemId: InventoryId | "all", requestedAmount: number | null) =>
    sellPlayerItems(playerId, itemId, requestedAmount, { mutatePlayerAndGlobal: fakeMutatePlayerAndGlobal });
  const journeyBuyPlayerUpgrade = (playerId: string, kind: "plots" | "irrigation" | "fertilizer", quantity: number) =>
    buyPlayerUpgrade(playerId, kind, quantity, { mutatePlayer: fakeMutatePlayer, getGlobalState: fakeGetGlobalState });
  const journeyCraftPlayerItem = (playerId: string, recipeId: ProductId, quantity: number) =>
    craftPlayerItem(playerId, recipeId, quantity, { mutatePlayer: fakeMutatePlayer, getGlobalState: fakeGetGlobalState });
  const journeyClaimPlayerDaily = (playerId: string) =>
    claimPlayerDaily(playerId, { mutatePlayer: fakeMutatePlayer, getGlobalState: fakeGetGlobalState });
  const journeyClaimPlayerQuest = (playerId: string, questIndex: number) =>
    claimPlayerQuest(playerId, questIndex, { mutatePlayer: fakeMutatePlayer, getGlobalState: fakeGetGlobalState });
  const journeyChoosePlayerSkin = (playerId: string, skinId: PlotSkinId) =>
    choosePlayerSkin(playerId, skinId, { mutatePlayer: fakeMutatePlayer, getGlobalState: fakeGetGlobalState });
  const journeyBuyPlayerWeatherForecast = (playerId: string) =>
    buyPlayerWeatherForecast(playerId, { mutatePlayer: fakeMutatePlayer, getGlobalState: fakeGetGlobalState });
  const journeyTogglePlayerAutoReplant = (playerId: string) =>
    togglePlayerAutoReplant(playerId, { mutatePlayer: fakeMutatePlayer, getGlobalState: fakeGetGlobalState });

  const meDeps: ActivityMeDeps = { ...commonDeps };

  async function getMe() {
    return resolveActivityMe(DISCORD_USER, poisonedJsonStore, meDeps);
  }

  // ==========================================================================
  // A. Ouvrir l'Activity -- lire le profil initial
  // ==========================================================================
  const initialMe = await getMe();
  assert.equal(initialMe.coins, 1000);
  assert.equal(initialMe.level, 10);
  assert.equal(initialMe.plots.length, 4);
  assert.ok(initialMe.plots.every((p) => "empty" in p && p.empty));

  // ==========================================================================
  // B/C. Planter sur la parcelle 1, verifier que ça persiste apres "refresh"
  // ==========================================================================
  const plantDeps: ActivityPlantDeps = { ...commonDeps, plantPlayerCrop: journeyPlantPlayerCrop };
  const plantResult = await resolveActivityPlant(DISCORD_USER, "wheat", 1, poisonedJsonStore, plantDeps);
  assert.equal(plantResult.coins, 995, "cout de la graine de blé (5 pièces) déduit");
  assert.equal(plantResult.plots[0]!.cropId, "wheat");

  const meAfterPlant = await getMe();
  assert.deepEqual(meAfterPlant.plots[0], plantResult.plots[0], "GET /me juste après plant() doit refléter EXACTEMENT le même état de parcelle (persistance après refresh)");
  assert.equal(meAfterPlant.coins, 995);

  // ==========================================================================
  // D/E/F. Simuler la pousse, récolter, vérifier inventaire + XP
  // ==========================================================================
  dbPlayer.plots[0]!.plantedAt = Date.now() - 10 * 60 * 1000; // largement au-delà de growMinutes(wheat)

  const harvestDeps: ActivityHarvestDeps = { ...commonDeps, harvestPlayerCrops: journeyHarvestPlayerCrops };
  const harvestResult = await resolveActivityHarvest(DISCORD_USER, poisonedJsonStore, harvestDeps);
  assert.equal(harvestResult.status, 200);
  const harvestPayload = harvestResult.status === 200 ? harvestResult.payload : (assert.fail("harvest attendu en 200"), null as never);
  assert.equal(harvestPayload.inventory.wheat, 3, "rendement blé (baseYield 3, sans engrais ni météo) = 3");
  assert.equal(harvestPayload.xp, 2, "XP blé = 2");
  assert.equal(harvestPayload.coins, 995, "la récolte ne coûte rien");
  assert.equal(harvestPayload.plots[0]!.empty, true, "parcelle libérée (pas d'auto-replant)");

  const meAfterHarvest = await getMe();
  assert.deepEqual(meAfterHarvest.inventory, harvestPayload.inventory, "GET /me juste après harvest() doit refléter EXACTEMENT le même inventaire");
  assert.equal(meAfterHarvest.xp, 2);
  assert.equal(meAfterHarvest.totalHarvested, 3);

  // ==========================================================================
  // H/I. Vendre l'inventaire, vérifier les coins
  // ==========================================================================
  const sellDeps: ActivitySellDeps = { ...commonDeps, sellPlayerItems: journeySellPlayerItems };
  const sellResult = await resolveActivitySell(DISCORD_USER, "wheat", null, poisonedJsonStore, sellDeps);
  assert.equal(sellResult.coins, 1007, "995 + (3 blé × 4 pièces) = 1007");
  assert.equal(sellResult.inventory.wheat, undefined, "inventaire vidé de ce type après vente totale");

  const meAfterSell = await getMe();
  assert.equal(meAfterSell.coins, sellResult.coins, "GET /me juste après sell() doit refléter EXACTEMENT les mêmes coins");

  // ==========================================================================
  // J/K. Acheter une parcelle supplémentaire, vérifier le nombre de parcelles
  // ==========================================================================
  const buyDeps: ActivityBuyDeps = { ...commonDeps, buyPlayerUpgrade: journeyBuyPlayerUpgrade };
  const buyPlotResult = await resolveActivityBuy(DISCORD_USER, "plots", 1, poisonedJsonStore, buyDeps);
  assert.equal(buyPlotResult.coins, 887, "1007 - 120 (coût 1ère parcelle supplémentaire) = 887");
  assert.equal(buyPlotResult.plots.length, 5);

  const meAfterBuyPlot = await getMe();
  assert.equal(meAfterBuyPlot.plots.length, buyPlotResult.plots.length, "GET /me juste après buy(plots) doit refléter EXACTEMENT le même nombre de parcelles");

  // ==========================================================================
  // L/M. Acheter irrigation, vérifier le niveau
  // ==========================================================================
  const buyIrrigationResult = await resolveActivityBuy(DISCORD_USER, "irrigation", 1, poisonedJsonStore, buyDeps);
  assert.equal(buyIrrigationResult.coins, 687, "887 - 200 (coût 1er niveau d'irrigation) = 687");
  assert.equal(buyIrrigationResult.irrigationLevel, 1);

  const meAfterIrrigation = await getMe();
  assert.equal(meAfterIrrigation.irrigationLevel, buyIrrigationResult.irrigationLevel, "GET /me juste après buy(irrigation) doit refléter EXACTEMENT le même niveau");

  // ==========================================================================
  // N/O. Acheter engrais, vérifier le niveau
  // ==========================================================================
  const buyFertilizerResult = await resolveActivityBuy(DISCORD_USER, "fertilizer", 1, poisonedJsonStore, buyDeps);
  assert.equal(buyFertilizerResult.coins, 487, "687 - 200 (coût 1er niveau d'engrais) = 487");
  assert.equal(buyFertilizerResult.fertilizerLevel, 1);

  const meAfterFertilizer = await getMe();
  assert.equal(meAfterFertilizer.fertilizerLevel, buyFertilizerResult.fertilizerLevel, "GET /me juste après buy(fertilizer) doit refléter EXACTEMENT le même niveau");

  // ==========================================================================
  // P/Q/R/S. Planter plusieurs parcelles (ici : replanter), récolter, craft,
  // vérifier ingrédients retirés + objet ajouté
  // ==========================================================================
  const plantAgainResult = await resolveActivityPlant(DISCORD_USER, "wheat", 1, poisonedJsonStore, plantDeps);
  assert.equal(plantAgainResult.coins, 482, "487 - 5 (graine de blé) = 482");

  dbPlayer.plots[0]!.plantedAt = Date.now() - 10 * 60 * 1000;
  const secondHarvestResult = await resolveActivityHarvest(DISCORD_USER, poisonedJsonStore, harvestDeps);
  assert.equal(secondHarvestResult.status, 200);
  const secondHarvestPayload = secondHarvestResult.status === 200 ? secondHarvestResult.payload : (assert.fail("harvest attendu en 200"), null as never);
  assert.equal(secondHarvestPayload.inventory.wheat, 3, "rendement blé avec engrais niveau 1 (×1.05) arrondi = round(3.15) = 3");
  assert.equal(secondHarvestPayload.coins, 482, "toujours pas de coût de récolte");

  const craftDeps: ActivityCraftDeps = { ...commonDeps, craftPlayerItem: journeyCraftPlayerItem };
  const craftResult = await resolveActivityCraft(DISCORD_USER, "bread", 1, poisonedJsonStore, craftDeps);
  assert.equal(craftResult.inventory.wheat, undefined, "les 3 blés (ingrédient de la recette pain) sont retirés de l'inventaire");
  assert.equal(craftResult.inventory.bread, 1, "1 pain ajouté à l'inventaire");
  assert.equal(craftResult.coins, 482, "le craft ne coûte pas de pièces, seulement des ingrédients");

  const meAfterCraft = await getMe();
  assert.deepEqual(meAfterCraft.inventory, craftResult.inventory, "GET /me juste après craft() doit refléter EXACTEMENT le même inventaire");

  // ==========================================================================
  // T. Vendre l'objet crafté
  // ==========================================================================
  const sellBreadResult = await resolveActivitySell(DISCORD_USER, "bread", null, poisonedJsonStore, sellDeps);
  assert.equal(sellBreadResult.coins, 500, "482 + 18 (prix de vente du pain) = 500");
  assert.equal(sellBreadResult.inventory.bread, undefined);

  const meAfterSellBread = await getMe();
  assert.equal(meAfterSellBread.coins, sellBreadResult.coins, "GET /me juste après sell(bread) doit refléter EXACTEMENT les mêmes coins");

  // ==========================================================================
  // U. Récompense quotidienne
  // ==========================================================================
  const dailyDeps: ActivityDailyDeps = { ...commonDeps, claimPlayerDaily: journeyClaimPlayerDaily };
  const dailyResult = await resolveActivityDaily(DISCORD_USER, poisonedJsonStore, dailyDeps);
  assert.equal(dailyResult.coins, 560, "500 + (40 + niveau 10 × 2 = 60) = 560");

  const meAfterDaily = await getMe();
  assert.equal(meAfterDaily.coins, dailyResult.coins, "GET /me juste après daily() doit refléter EXACTEMENT les mêmes coins");

  // ==========================================================================
  // V. Missions quotidiennes -- claim de mission
  // ==========================================================================
  const questClaimDeps: ActivityQuestClaimDeps = { ...commonDeps, claimPlayerQuest: journeyClaimPlayerQuest };
  const questClaimResult = await resolveActivityQuestClaim(DISCORD_USER, 0, poisonedJsonStore, questClaimDeps);
  assert.equal(questClaimResult.coins, 610, "560 + 50 (récompense de la mission) = 610");
  assert.equal(questClaimResult.quests[0]!.claimed, true);

  const meAfterQuest = await getMe();
  assert.equal(meAfterQuest.coins, questClaimResult.coins, "GET /me juste après quest-claim() doit refléter EXACTEMENT les mêmes coins");
  assert.deepEqual(meAfterQuest.quests, questClaimResult.quests, "GET /me juste après quest-claim() doit refléter EXACTEMENT le même état de quête");

  // ==========================================================================
  // W/X. Activer la replantation auto, planter/récolter avec auto-replant
  // ==========================================================================
  const autoreplantDeps: ActivityAutoreplantDeps = { ...commonDeps, togglePlayerAutoReplant: journeyTogglePlayerAutoReplant };
  const toggleOnResult = await resolveActivityAutoreplant(DISCORD_USER, poisonedJsonStore, autoreplantDeps);
  assert.equal(toggleOnResult.autoReplant, true);

  const meAfterToggle = await getMe();
  assert.equal(meAfterToggle.autoReplant, true, "GET /me juste après autoreplant() doit refléter EXACTEMENT le même flag");

  const plantForAutoReplantResult = await resolveActivityPlant(DISCORD_USER, "wheat", 1, poisonedJsonStore, plantDeps);
  assert.equal(plantForAutoReplantResult.coins, 605, "610 - 5 (graine de blé) = 605");

  dbPlayer.plots[0]!.plantedAt = Date.now() - 10 * 60 * 1000;
  const autoReplantHarvestResult = await resolveActivityHarvest(DISCORD_USER, poisonedJsonStore, harvestDeps);
  assert.equal(autoReplantHarvestResult.status, 200);
  const autoReplantHarvestPayload = autoReplantHarvestResult.status === 200 ? autoReplantHarvestResult.payload : (assert.fail("harvest attendu en 200"), null as never);
  assert.equal(autoReplantHarvestPayload.coins, 600, "605 - 5 (replantation automatique de la graine) = 600");
  assert.equal(autoReplantHarvestPayload.plots[0]!.empty, undefined, "la parcelle reste occupée grâce à l'auto-replant (pas de clé 'empty' pour une parcelle occupée)");
  assert.equal((autoReplantHarvestPayload.plots[0] as { cropId?: string }).cropId, "wheat", "toujours plantée en blé après la replantation automatique");
  assert.equal(autoReplantHarvestPayload.plots[0]!.ready, false, "fraîchement replantée, pas encore prête");
  assert.equal(autoReplantHarvestPayload.inventory.wheat, 3, "récolte quand même collectée avant la replantation");

  const meAfterAutoReplantHarvest = await getMe();
  assert.deepEqual(meAfterAutoReplantHarvest.plots[0], autoReplantHarvestPayload.plots[0], "GET /me juste après une récolte auto-replant doit refléter EXACTEMENT le même état de parcelle");
  assert.equal(meAfterAutoReplantHarvest.coins, autoReplantHarvestPayload.coins);

  // ==========================================================================
  // (skins) Choisir un thème de parcelle débloqué
  // ==========================================================================
  const skinDeps: ActivitySkinDeps = { ...commonDeps, choosePlayerSkin: journeyChoosePlayerSkin };
  const skinResult = await resolveActivitySkin(DISCORD_USER, "autumn", poisonedJsonStore, skinDeps);
  assert.equal(skinResult.plotSkin, "autumn");
  assert.equal(skinResult.coins, 600, "le changement de thème ne coûte rien");

  const meAfterSkin = await getMe();
  assert.equal(meAfterSkin.plotSkin, skinResult.plotSkin, "GET /me juste après skin() doit refléter EXACTEMENT le même thème");

  // ==========================================================================
  // Y. Marché/météo -- météo actuelle visible, prochaine météo VERROUILLEE
  // tant qu'aucune prévision n'a été achetée, puis achat d'une prévision
  // ==========================================================================
  const meBeforeForecast = await getMe();
  assert.deepEqual(meBeforeForecast.weather.current, { key: "normal", ...WEATHER_INFO.normal }, "météo actuelle toujours visible, sans achat");
  assert.equal(meBeforeForecast.weather.nextChangeAt, dbGlobal.nextWeatherAt, "le TIMESTAMP du prochain changement est toujours exposé (ne révèle pas le type de météo)");
  assert.equal(meBeforeForecast.weather.forecast, null, "aucune prévision achetée -> prochaine météo VERROUILLÉE, aucune fuite");
  assert.equal(meBeforeForecast.weather.forecastPurchased, false);
  assert.equal(JSON.stringify(meBeforeForecast).includes(dbGlobal.nextWeatherType), false, "le payload ne doit contenir AUCUNE trace du type de la prochaine météo avant achat");

  const forecastDeps: ActivityForecastDeps = { ...commonDeps, buyPlayerWeatherForecast: journeyBuyPlayerWeatherForecast };
  const forecastResult = await resolveActivityForecast(DISCORD_USER, poisonedJsonStore, forecastDeps);
  assert.equal(forecastResult.coins, 585, "600 - 15 (coût de la prévision météo) = 585");
  assert.equal(forecastResult.weatherForecast, "rain", "doit refléter global.nextWeatherType");
  assert.deepEqual(forecastResult.weather.forecast, { key: "rain", ...WEATHER_INFO.rain }, "la prévision achetée est immédiatement révélée avec son effet réel");
  assert.equal(forecastResult.weather.forecastPurchased, true);

  const meAfterForecast = await getMe();
  assert.equal(meAfterForecast.coins, forecastResult.coins, "GET /me juste après forecast() doit refléter EXACTEMENT les mêmes coins");
  assert.equal(meAfterForecast.weatherForecast, forecastResult.weatherForecast);
  assert.deepEqual(meAfterForecast.weather.forecast, forecastResult.weather.forecast, "GET /me juste après forecast() doit refléter EXACTEMENT la même prévision (pas de re-verrouillage)");
  assert.equal(meAfterForecast.weather.forecastPurchased, true);

  // ==========================================================================
  // Z. Simuler fermeture/réouverture de l'Activity : relire /activity/me et
  // vérifier que TOUT l'état accumulé persiste, cohérent de bout en bout.
  // ==========================================================================
  const finalMe = await getMe();
  assert.equal(finalMe.coins, 585);
  assert.equal(finalMe.level, 10);
  assert.equal(finalMe.xp, 6, "2 (récolte 1) + 2 (récolte 2) + 2 (récolte auto-replant) = 6");
  assert.equal(finalMe.irrigationLevel, 1);
  assert.equal(finalMe.fertilizerLevel, 1);
  assert.equal(finalMe.autoReplant, true);
  assert.equal(finalMe.plotSkin, "autumn");
  assert.equal(finalMe.plots.length, 5);
  assert.equal(finalMe.plots[0]!.empty, undefined, "parcelle 1 occupée (auto-replant), pas de clé 'empty'");
  assert.equal((finalMe.plots[0] as { cropId?: string }).cropId, "wheat");
  assert.equal(finalMe.inventory.wheat, 3);
  assert.equal(finalMe.inventory.bread, undefined, "le pain a été vendu");
  assert.equal(finalMe.totalHarvested, 9, "3 + 3 + 3 = 9 blés récoltés au total");
  assert.equal(finalMe.quests[0]!.claimed, true);
  assert.equal(finalMe.weatherForecast, "rain");
  assert.deepEqual(finalMe.weather.forecast, { key: "rain", ...WEATHER_INFO.rain }, "la prévision achetée respecte exactement l'état PostgreSQL réel après fermeture/réouverture");
  assert.equal(finalMe.weather.forecastPurchased, true);
  assert.deepEqual(finalMe.weather.current, { key: "normal", ...WEATHER_INFO.normal });
});

// ===========================================================================
// LOT ACTIVITY-UX-QUANTITIES -- craft en quantite >1 EN UNE SEULE requete,
// puis vente partielle suivie d'une vente du reste ("MAX"), de bout en
// bout contre les VRAIES fonctions farm.ts (meme fake-DB en memoire que le
// player journey ci-dessus, fixture independante pour ne pas perturber les
// totaux du scenario precedent).
//
// H. (previews) : les valeurs ci-dessous sont EXACTEMENT celles que
// computeCraftPreview()/computeSellPreview() (quantitySelector.js, cote
// frontend -- deja testees isolement dans quantitySelector.test.js avec
// les memes chiffres : Pain = 3 x blé, prix blé = 4) calculeraient AVANT
// meme d'envoyer la requete : la preview et la realite backend
// convergent parce que les DEUX utilisent la MEME recette RECIPES/le MEME
// prix, jamais une formule dupliquee/divergente.
test("PLAYER JOURNEY -- LOT ACTIVITY-UX-QUANTITIES : craft quantite >1 en une requete, puis vente partielle + vente du reste (MAX), coherent de bout en bout", async () => {
  const journeyNow = Date.now();

  const dbPlayer: PlayerState = {
    userId: TEST_PLAYER_ID,
    coins: 0,
    level: 10,
    xp: 0,
    // A. Obtenir suffisamment de blé -- seede directement l'inventaire
    // (le chemin plant -> attendre la pousse -> récolter est déjà exercé
    // en profondeur par le player journey principal ci-dessus ; celui-ci
    // se concentre sur craft/sell en quantité).
    plots: [{ cropId: null, plantedAt: null, notifiedReady: false }],
    inventory: { wheat: 20 },
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: 0,
    createdAt: journeyNow,
    updatedAt: journeyNow,
    totalHarvested: 0,
    quests: [],
    questsResetAt: journeyNow,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: null,
  };

  const dbGlobal: GlobalState = {
    marketMultiplier: 1,
    previousMarketMultiplier: 1,
    marketUpdatedAt: journeyNow,
    weather: "normal",
    weatherMultiplier: 1,
    weatherChangedAt: null,
    weatherExpiresAt: null,
    nextWeatherAt: journeyNow,
    nextWeatherType: "rain",
    contract: { cropId: "carrot", required: 20, remaining: 20, bonusMultiplier: 1.6, renewedAt: journeyNow },
    weeklyStartedAt: journeyNow,
    dailyChallenge: {
      cropId: "potato",
      target: 200,
      progress: 0,
      contributors: [],
      rewardCoins: 80,
      startedAt: journeyNow,
      completed: false,
      rewarded: false,
    },
  };

  async function fakeMutatePlayer(
    _playerId: string,
    mutator: (player: PlayerState) => void | Promise<void>,
  ): Promise<PlayerState> {
    await mutator(dbPlayer);
    return dbPlayer;
  }
  async function fakeMutatePlayerAndGlobal(
    _playerId: string,
    mutator: (player: PlayerState, global: GlobalState) => void | Promise<void>,
  ): Promise<{ player: PlayerState; global: GlobalState }> {
    await mutator(dbPlayer, dbGlobal);
    return { player: dbPlayer, global: dbGlobal };
  }
  async function fakeGetGlobalState(): Promise<GlobalState | null> {
    return dbGlobal;
  }
  async function fakeGetPlayer(_playerId: string): Promise<PlayerState | null> {
    return dbPlayer;
  }
  async function fakeEnsurePlayerExists(_playerId: string) {
    return { player: dbPlayer, created: false };
  }
  const shouldUsePostgresRuntime = () => true;
  const requireDiscordUser = async (_authHeader: string | undefined) => DISCORD_USER;
  const getFarmStore = async () => poisonedJsonStore;

  const commonDeps = {
    requireDiscordUser,
    getFarmStore,
    shouldUsePostgresRuntime,
    ensurePlayerExists: fakeEnsurePlayerExists,
    getPlayer: fakeGetPlayer,
    getGlobalState: fakeGetGlobalState,
  };

  const journeyCraftPlayerItem = (playerId: string, recipeId: ProductId, quantity: number) =>
    craftPlayerItem(playerId, recipeId, quantity, { mutatePlayer: fakeMutatePlayer, getGlobalState: fakeGetGlobalState });
  const journeySellPlayerItems = (playerId: string, itemId: InventoryId | "all", requestedAmount: number | null) =>
    sellPlayerItems(playerId, itemId, requestedAmount, { mutatePlayerAndGlobal: fakeMutatePlayerAndGlobal });

  const meDeps: ActivityMeDeps = { ...commonDeps };
  async function getMe() {
    return resolveActivityMe(DISCORD_USER, poisonedJsonStore, meDeps);
  }

  // ==========================================================================
  // B. Craft plusieurs pains en UNE SEULE requête (quantity > 1)
  // ==========================================================================
  const craftDeps: ActivityCraftDeps = { ...commonDeps, craftPlayerItem: journeyCraftPlayerItem };
  const craftResult = await resolveActivityCraft(DISCORD_USER, "bread", 5, poisonedJsonStore, craftDeps);
  assert.equal(craftResult.inventory.wheat, 5, "20 - (3 blé x 5 pains) = 5 blés restants");
  assert.equal(craftResult.inventory.bread, 5, "5 pains produits en UNE requête (quantity=5)");

  // ==========================================================================
  // C. Vérifier l'inventaire (persistance)
  // ==========================================================================
  const meAfterCraft = await getMe();
  assert.deepEqual(meAfterCraft.inventory, craftResult.inventory, "GET /me juste après craft(quantity=5) doit refléter EXACTEMENT le même inventaire");

  // ==========================================================================
  // D. Vendre SEULEMENT une partie (amount > 1 mais < stock total : 2 sur 5)
  // ==========================================================================
  const sellDeps: ActivitySellDeps = { ...commonDeps, sellPlayerItems: journeySellPlayerItems };
  const partialSellResult = await resolveActivitySell(DISCORD_USER, "bread", 2, poisonedJsonStore, sellDeps);
  assert.equal(partialSellResult.coins, 36, "2 pains x 18 pièces (prix de vente du pain) = 36");
  assert.equal(partialSellResult.inventory.bread, 3, "5 - 2 = 3 pains restants, PAS tout l'inventaire vendu");

  // ==========================================================================
  // E. Vérifier inventaire restant + coins
  // ==========================================================================
  const meAfterPartialSell = await getMe();
  assert.equal(meAfterPartialSell.coins, 36);
  assert.equal(meAfterPartialSell.inventory.bread, 3);

  // ==========================================================================
  // F. Vendre le reste avec "MAX" (montant EXACT du stock restant, comme le
  // ferait le bouton MAX cote frontend -- pas itemId:"all")
  // ==========================================================================
  const remainingStock = meAfterPartialSell.inventory.bread ?? 0;
  const maxSellResult = await resolveActivitySell(DISCORD_USER, "bread", remainingStock, poisonedJsonStore, sellDeps);
  assert.equal(maxSellResult.coins, 90, "36 + (3 pains x 18 pièces) = 90");
  assert.equal(maxSellResult.inventory.bread, undefined, "plus aucun pain -- inventaire vidé de ce type");

  // ==========================================================================
  // G. GET /me final cohérent
  // ==========================================================================
  const finalMe = await getMe();
  assert.equal(finalMe.coins, maxSellResult.coins);
  assert.deepEqual(finalMe.inventory, maxSellResult.inventory, "GET /me final doit refléter EXACTEMENT le même inventaire (aucun pain, 5 blés restants)");
  assert.equal(finalMe.inventory.wheat, 5);
  assert.equal(finalMe.coins, 90);
});
