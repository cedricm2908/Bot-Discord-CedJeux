// Tests de routes/activity.ts -- TOUTES les routes de mutation Activity
// sont maintenant migrees vers PostgreSQL pour les joueurs allowlistes :
// LOT A (GET /activity/me, lecture seule) + LOT ACTIVITY-PG1 (plant) +
// LOT ACTIVITY-PG2 (harvest) + LOT ACTIVITY-PG3 (sell, buy) + LOT
// ACTIVITY-PG4 (craft, daily, quest-claim, skin, forecast, autoreplant).
// Aucune connexion Neon/Railway, aucune vraie requete vers discord.com :
// requireDiscordUser/getFarmStore/shouldUsePostgresRuntime/
// ensurePlayerExists/plantPlayerCrop/harvestPlayerCrops/sellPlayerItems/
// buyPlayerUpgrade/craftPlayerItem/claimPlayerDaily/claimPlayerQuest/
// choosePlayerSkin/buyPlayerWeatherForecast/togglePlayerAutoReplant/
// getPlayer/getGlobalState sont tous injectes via ActivityMeDeps/
// ActivityPlantDeps/ActivityHarvestDeps/ActivitySellDeps/ActivityBuyDeps/
// ActivityCraftDeps/ActivityDailyDeps/ActivityQuestClaimDeps/
// ActivitySkinDeps/ActivityForecastDeps/ActivityAutoreplantDeps (meme
// convention deps que farmPlayerActions.test.ts/presenters.test.ts).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  buildActivityCropsPayload,
  handleActivityAutoreplant,
  handleActivityBuy,
  handleActivityCraft,
  handleActivityDaily,
  handleActivityForecast,
  handleActivityHarvest,
  handleActivityPlant,
  handleActivityQuestClaim,
  handleActivitySell,
  handleActivitySkin,
  handleGetActivityMe,
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
import { FarmError } from "../discord/farm.ts";
import { WEATHER_INFO } from "../discord/constants.ts";
import type { FarmStore } from "../discord/store";
import type { GlobalState, InventoryId, PlayerState, PlotSkinId, ProductId, QuestProgress, WeatherKey } from "../discord/types";

const NOW = 1_700_000_000_000;
const TEST_PLAYER_ID = "v2-test-player-001";

function buildPlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    userId: TEST_PLAYER_ID,
    coins: 200,
    level: 3,
    xp: 10,
    plots: [
      { cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
    ],
    inventory: { wheat: 5 },
    irrigationLevel: 1,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: 200,
    createdAt: NOW,
    updatedAt: NOW,
    totalHarvested: 12,
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

function buildFakeStore(overrides: {
  player?: PlayerState;
  global?: GlobalState;
  getPlayer?: ReturnType<typeof mock.fn>;
  save?: ReturnType<typeof mock.fn>;
} = {}): FarmStore {
  const player = overrides.player ?? buildPlayerState();
  return {
    getPlayer: overrides.getPlayer ?? mock.fn((_userId: string) => player),
    save: overrides.save ?? mock.fn(async () => {}),
    global: overrides.global ?? buildGlobalState(),
  } as unknown as FarmStore;
}

function buildDeps(overrides: Partial<ActivityMeDeps> = {}): ActivityMeDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivityMeDeps["ensurePlayerExists"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivityMeDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityMeDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakeRes(): { statusCode: number; status: ReturnType<typeof mock.fn>; json: ReturnType<typeof mock.fn> } {
  const res = {
    statusCode: 200,
    status: undefined as unknown as ReturnType<typeof mock.fn>,
    json: mock.fn((_body: unknown) => res),
  };
  res.status = mock.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  return res;
}

function buildFakeReq(authHeader: string | undefined): { headers: { authorization: string | undefined }; body: unknown; query: unknown } {
  return { headers: { authorization: authHeader }, body: { userId: "attacker-supplied-id" }, query: { userId: "attacker-supplied-id" } };
}

// ===========================================================================
// CAS 1 -- joueur non allowliste
// ===========================================================================

test("GET /activity/me -- CAS 1 : joueur non allowliste -> chemin JSON V1 utilise, aucune primitive Postgres appelee", async () => {
  const player = buildPlayerState();
  const store = buildFakeStore({ player });
  const deps = buildDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityMeDeps["ensurePlayerExists"],
    getPlayer: mock.fn(async () => {
      throw new Error("getPlayer (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityMeDeps["getPlayer"],
    getGlobalState: mock.fn(async () => {
      throw new Error("getGlobalState (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityMeDeps["getGlobalState"],
  });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  assert.equal(res.status.mock.calls.length, 0, "aucune erreur : pas de code de statut explicite, 200 implicite via res.json");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ coins: number; user: { id: string } }];
  assert.equal(payload.user.id, TEST_PLAYER_ID);
  assert.equal(payload.coins, player.coins, "la reponse doit refleter le PlayerState JSON (store), pas un autre etat");
});

// ===========================================================================
// CAS 2 -- joueur allowliste
// ===========================================================================

test("GET /activity/me -- CAS 2 : joueur allowliste -> ensurePlayerExists + getPlayer + getGlobalState Postgres, store JSON jamais touche", async () => {
  const pgPlayer = buildPlayerState({ coins: 999 });
  const pgGlobal = buildGlobalState({ weather: "rain", weatherMultiplier: 1.25 });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: pgPlayer, created: false })) as unknown as ActivityMeDeps["ensurePlayerExists"];
  const getPlayer = mock.fn(async (_playerId: string) => pgPlayer) as unknown as ActivityMeDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityMeDeps["getGlobalState"];
  const jsonGetPlayer = mock.fn(() => {
    throw new Error("store.getPlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const jsonSave = mock.fn(async () => {
    throw new Error("store.save (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = buildFakeStore({ getPlayer: jsonGetPlayer, save: jsonSave });
  const deps = buildDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonGetPlayer.mock.calls.length, 0, "store.getPlayer (JSON) ne doit jamais etre appele");
  assert.equal(jsonSave.mock.calls.length, 0, "store.save (JSON) ne doit jamais etre appele");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ coins: number }];
  assert.equal(payload.coins, 999, "la reponse doit refleter le PlayerState Postgres, pas le store JSON");
});

// ===========================================================================
// CAS 3 -- contrat de reponse identique entre les deux branches
// ===========================================================================

test("GET /activity/me -- CAS 3 : buildMePayload produit exactement la meme forme (memes cles) pour un etat logique equivalent, JSON et Postgres", async () => {
  const sharedPlayer = buildPlayerState();
  const sharedGlobal = buildGlobalState();

  const v1Result = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore({ player: sharedPlayer, global: sharedGlobal }),
    buildDeps({ shouldUsePostgresRuntime: mock.fn(() => false) }),
  );
  const pgResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    buildDeps({
      shouldUsePostgresRuntime: mock.fn(() => true),
      getPlayer: mock.fn(async () => sharedPlayer) as unknown as ActivityMeDeps["getPlayer"],
      getGlobalState: mock.fn(async () => sharedGlobal) as unknown as ActivityMeDeps["getGlobalState"],
    }),
  );

  assert.deepEqual(
    Object.keys(v1Result).sort(),
    Object.keys(pgResult).sort(),
    "les deux branches doivent produire exactement les memes cles de premier niveau",
  );
  assert.deepEqual(Object.keys(v1Result.global).sort(), Object.keys(pgResult.global).sort());
  assert.deepEqual(Object.keys(v1Result.dailyChallenge).sort(), Object.keys(pgResult.dailyChallenge).sort());
  assert.deepEqual(v1Result.plots[0], pgResult.plots[0], "une parcelle occupee doit avoir un rendu identique dans les deux branches");
  assert.deepEqual(v1Result.plots[1], pgResult.plots[1], "une parcelle vide doit avoir un rendu identique dans les deux branches");
  assert.deepEqual(v1Result, pgResult, "pour un etat logique identique, la reponse complete doit etre strictement identique");
});

// ===========================================================================
// CAS 4 -- erreur Postgres : aucun repli JSON, reponse 500 controlee
// ===========================================================================

test("GET /activity/me -- CAS 4 : ensurePlayerExists (Postgres) rejette -> reponse 500 controlee, AUCUN repli vers le store JSON", async () => {
  const jsonGetPlayer = mock.fn(() => {
    throw new Error("store.getPlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const jsonSave = mock.fn(async () => {
    throw new Error("store.save (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = buildFakeStore({ getPlayer: jsonGetPlayer, save: jsonSave });
  const deps = buildDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("panne Postgres simulee (ensurePlayerExists)");
    }) as unknown as ActivityMeDeps["ensurePlayerExists"],
  });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  assert.equal(jsonGetPlayer.mock.calls.length, 0);
  assert.equal(jsonSave.mock.calls.length, 0);
  assert.equal(res.status.mock.calls.length, 1);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 500);
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Erreur serveur");
});

// ===========================================================================
// CAS 5 -- getPlayer (Postgres) retourne null malgre ensurePlayerExists
// ===========================================================================
// Le type de retour de getPlayer() (farmRepository.ts) est explicitement
// `PlayerState | null` -- ce cas n'est donc pas rendu impossible par le
// systeme de types, meme s'il ne devrait jamais se produire en pratique
// (ensurePlayerExists garantit la creation avant de relire). Teste ici
// comme garde defensive explicite, conformement a la consigne LOT A.

test("GET /activity/me -- CAS 5 : getPlayer (Postgres) retourne null apres ensurePlayerExists -> erreur controlee, aucun repli JSON", async () => {
  const jsonGetPlayer = mock.fn(() => {
    throw new Error("store.getPlayer (JSON) ne doit jamais etre appele");
  });
  const store = buildFakeStore({ getPlayer: jsonGetPlayer });
  const deps = buildDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => ({ player: buildPlayerState(), created: true })) as unknown as ActivityMeDeps["ensurePlayerExists"],
    getPlayer: mock.fn(async () => null) as unknown as ActivityMeDeps["getPlayer"],
  });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  assert.equal(jsonGetPlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 500);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Erreur serveur");
});

// ===========================================================================
// Section 7 -- Auth / identite
// ===========================================================================

test("GET /activity/me -- Bearer absent -> 401, aucune primitive Postgres/JSON appelee", async () => {
  const deps = buildDeps({
    requireDiscordUser: mock.fn(async () => null),
    shouldUsePostgresRuntime: mock.fn(() => {
      throw new Error("shouldUsePostgresRuntime ne doit jamais etre appele sans identite Discord resolue");
    }),
  });
  const req = buildFakeReq(undefined);
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  assert.equal(res.status.mock.calls[0]!.arguments[0], 401);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Token Discord invalide");
});

test("GET /activity/me -- Bearer invalide (requireDiscordUser retourne null) -> 401", async () => {
  const deps = buildDeps({ requireDiscordUser: mock.fn(async () => null) });
  const req = buildFakeReq("Bearer token-invalide-ou-expire");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  assert.equal(res.status.mock.calls[0]!.arguments[0], 401);
});

test("GET /activity/me -- l'identite joueur provient UNIQUEMENT du resultat requireDiscordUser (mocke), jamais de req.body/req.query", async () => {
  // buildFakeReq() place volontairement un faux userId dans body ET query
  // ("attacker-supplied-id") -- si le code les lisait, shouldUsePostgresRuntime/
  // getPlayer recevraient cette valeur au lieu de TEST_PLAYER_ID.
  const shouldUsePostgresRuntime = mock.fn((_playerId: string) => true);
  const getPlayer = mock.fn(async () => buildPlayerState()) as unknown as ActivityMeDeps["getPlayer"];
  const deps = buildDeps({
    requireDiscordUser: mock.fn(async () => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    shouldUsePostgresRuntime,
    ensurePlayerExists: mock.fn(async () => ({ player: buildPlayerState(), created: false })) as unknown as ActivityMeDeps["ensurePlayerExists"],
    getPlayer,
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityMeDeps["getGlobalState"],
  });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  assert.equal(shouldUsePostgresRuntime.mock.calls[0]!.arguments[0], TEST_PLAYER_ID, "jamais \"attacker-supplied-id\" (body/query)");
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
});

// ===========================================================================
// Section 9 -- Reset de quetes : V1 conserve son reset, Postgres n'en fait
// PAS ENCORE (reserve au LOT B)
// ===========================================================================

test("GET /activity/me -- V1 (non allowliste) : quetes perimees -> resetQuestsIfNeeded reel declenche store.save()", async () => {
  const stalePlayer = buildPlayerState({ questsResetAt: 0, quests: [] });
  const save = mock.fn(async () => {});
  const store = buildFakeStore({ player: stalePlayer, save });
  const deps = buildDeps({ shouldUsePostgresRuntime: mock.fn(() => false), getFarmStore: mock.fn(async () => store) });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  assert.equal(save.mock.calls.length, 1, "resetQuestsIfNeeded(questsResetAt=0) doit reellement declencher store.save() en V1, comportement inchange");
});

test("GET /activity/me -- Postgres (allowliste) : AUCUN reset de quetes n'est declenche, le PlayerState Postgres est retourne tel quel (LOT A = lecture seule, reset reserve au LOT B)", async () => {
  const stalePgPlayer = buildPlayerState({ questsResetAt: 0, quests: [] });
  const getPlayer = mock.fn(async () => stalePgPlayer) as unknown as ActivityMeDeps["getPlayer"];
  const jsonSave = mock.fn(async () => {
    throw new Error("aucune ecriture (JSON ou Postgres) n'est attendue pour LOT A cote Postgres");
  });
  const store = buildFakeStore({ save: jsonSave });
  const deps = buildDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => ({ player: stalePgPlayer, created: false })) as unknown as ActivityMeDeps["ensurePlayerExists"],
    getPlayer,
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityMeDeps["getGlobalState"],
  });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  assert.equal(jsonSave.mock.calls.length, 0, "aucune primitive d'ecriture n'est disponible/appelee dans la branche Postgres de LOT A");
  const [payload] = res.json.mock.calls[0]!.arguments as [{ quests: unknown[] }];
  assert.deepEqual(payload.quests, stalePgPlayer.quests, "le PlayerState Postgres, y compris ses quetes perimees, est retourne SANS mutation -- reset explicitement reserve au LOT B");
});

// ===========================================================================
// LOT ACTIVITY-PG1 -- POST /activity/plant
// ===========================================================================

function buildPlantDeps(overrides: Partial<ActivityPlantDeps> = {}): ActivityPlantDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivityPlantDeps["ensurePlayerExists"],
    plantPlayerCrop: mock.fn(async (_playerId: string, _cropId: string, _plot: number | null) => 1) as unknown as ActivityPlantDeps["plantPlayerCrop"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivityPlantDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityPlantDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakePlantReq(authHeader: string | undefined, body: unknown): { headers: { authorization: string | undefined }; body: unknown } {
  return { headers: { authorization: authHeader }, body };
}

// ===========================================================================
// TEST 1 -- joueur allowliste Postgres
// ===========================================================================

test("POST /activity/plant -- TEST 1 : joueur allowliste -> ensurePlayerExists + plantPlayerCrop + getPlayer + getGlobalState Postgres, store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const plantedPlayer = buildPlayerState({
    plots: [
      { cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false },
      { cropId: "carrot", plantedAt: NOW, notifiedReady: false },
    ],
  });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: plantedPlayer, created: false })) as unknown as ActivityPlantDeps["ensurePlayerExists"];
  const plantPlayerCrop = mock.fn(async (_playerId: string, _cropId: string, _plot: number | null) => 2) as unknown as ActivityPlantDeps["plantPlayerCrop"];
  const getPlayer = mock.fn(async (_playerId: string) => plantedPlayer) as unknown as ActivityPlantDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivityPlantDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildPlantDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    plantPlayerCrop,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakePlantReq("Bearer real-discord-token", { cropId: "carrot", plot: 2 });
  const res = buildFakeRes();

  await handleActivityPlant(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal((plantPlayerCrop as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.deepEqual((plantPlayerCrop as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments, [TEST_PLAYER_ID, "carrot", 2]);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.status.mock.calls.length, 0, "pas d'erreur : 200 implicite via res.json");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ plots: { index: number; cropId?: string; empty?: boolean }[] }];
  assert.equal(payload.plots[1]!.cropId, "carrot", "le plot plante doit apparaitre dans la reponse, refletant l'etat Postgres fraichement relu");
});

// ===========================================================================
// TEST 2 -- joueur non allowliste
// ===========================================================================

test("POST /activity/plant -- TEST 2 : joueur non allowliste -> chemin JSON V1 conserve, aucune primitive Postgres appelee", async () => {
  const jsonPlayer = buildPlayerState({
    plots: [
      { cropId: "wheat", plantedAt: NOW, notifiedReady: false },
      { cropId: "carrot", plantedAt: NOW, notifiedReady: false },
    ],
  });
  const jsonMutatePlayer = mock.fn(async (_playerId: string, _mutator: (p: PlayerState) => void) => jsonPlayer);
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildPlantDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityPlantDeps["ensurePlayerExists"],
    plantPlayerCrop: mock.fn(async () => {
      throw new Error("plantPlayerCrop (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityPlantDeps["plantPlayerCrop"],
    getPlayer: mock.fn(async () => {
      throw new Error("getPlayer (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityPlantDeps["getPlayer"],
    getGlobalState: mock.fn(async () => {
      throw new Error("getGlobalState (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityPlantDeps["getGlobalState"],
  });
  const req = buildFakePlantReq("Bearer real-discord-token", { cropId: "carrot", plot: 2 });
  const res = buildFakeRes();

  await handleActivityPlant(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange");
  assert.equal(jsonMutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ plots: { index: number; cropId?: string; empty?: boolean }[] }];
  assert.equal(payload.plots[1]!.cropId, "carrot");
});

// ===========================================================================
// TEST 3 -- erreur metier (parcelle deja occupee) : meme semantique FarmError
// ===========================================================================

test("POST /activity/plant -- TEST 3 : plantPlayerCrop (Postgres) rejette avec FarmError -> 400 avec le meme message, aucun repli JSON", async () => {
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildPlantDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    plantPlayerCrop: mock.fn(async () => {
      throw new FarmError("La parcelle 1 est déjà occupée.");
    }) as unknown as ActivityPlantDeps["plantPlayerCrop"],
  });
  const req = buildFakePlantReq("Bearer real-discord-token", { cropId: "wheat", plot: 1 });
  const res = buildFakeRes();

  await handleActivityPlant(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls.length, 1);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 400, "meme statut que le chemin JSON pour une FarmError -- semantique d'erreur inchangee");
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "La parcelle 1 est déjà occupée.");
});

// ===========================================================================
// TEST 4 -- coherence read-after-write : POST /plant puis GET /me
// ===========================================================================

test("POST /activity/plant puis GET /activity/me -- TEST 4 : meme etat de parcelle des deux cotes pour un joueur allowliste (plus de decalage JSON/Postgres)", async () => {
  // Simule une "table Postgres" en memoire, mutee par le mock
  // plantPlayerCrop exactement comme le ferait la vraie primitive
  // (farmPlayerActions.ts -> mutatePlayer -> plant()), puis relue par les
  // DEUX resolveurs (plant et me) via le meme getPlayer.
  const pgPlayerState = buildPlayerState({
    plots: [
      { cropId: null, plantedAt: null, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
    ],
  });
  const pgGlobal = buildGlobalState();
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityPlantDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityPlantDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const plantPlayerCrop = mock.fn(async (_playerId: string, cropId: string, plotNumber: number | null) => {
    const index = (plotNumber ?? 1) - 1;
    pgPlayerState.plots[index] = { cropId: cropId as PlayerState["plots"][number]["cropId"], plantedAt: NOW, notifiedReady: false };
    return plotNumber ?? 1;
  }) as unknown as ActivityPlantDeps["plantPlayerCrop"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivityPlantDeps["ensurePlayerExists"];

  const plantResult = await resolveActivityPlant(
    { id: TEST_PLAYER_ID, username: "tester" },
    "carrot",
    2,
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, plantPlayerCrop, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.deepEqual(
    meResult.plots[1],
    plantResult.plots[1],
    "GET /activity/me juste apres POST /activity/plant doit refleter EXACTEMENT la meme parcelle plantee -- plus de decalage entre les deux routes",
  );
  assert.equal(meResult.plots[1]!.cropId, "carrot");
});

// ===========================================================================
// LOT ACTIVITY-PG2 -- POST /activity/harvest
// ===========================================================================

function buildHarvestDeps(overrides: Partial<ActivityHarvestDeps> = {}): ActivityHarvestDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivityHarvestDeps["ensurePlayerExists"],
    harvestPlayerCrops: mock.fn(async (_playerId: string) => ({
      result: { harvested: [{ cropId: "wheat" as const, amount: 4, xp: 2, replanted: false }], totalXp: 2, leveledUpTo: 1 },
      global: buildGlobalState(),
    })) as unknown as ActivityHarvestDeps["harvestPlayerCrops"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivityHarvestDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityHarvestDeps["getGlobalState"],
    ...overrides,
  };
}

// ===========================================================================
// TEST 1 -- joueur allowliste Postgres
// ===========================================================================

test("POST /activity/harvest -- TEST 1 : joueur allowliste -> ensurePlayerExists + harvestPlayerCrops + getPlayer + getGlobalState Postgres, store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const harvestedPlayer = buildPlayerState({
    plots: [
      { cropId: null, plantedAt: null, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
    ],
    inventory: { wheat: 9 },
    xp: 12,
    totalHarvested: 16,
  });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: harvestedPlayer, created: false })) as unknown as ActivityHarvestDeps["ensurePlayerExists"];
  const harvestPlayerCrops = mock.fn(async (_playerId: string) => ({
    result: { harvested: [{ cropId: "wheat" as const, amount: 4, xp: 2, replanted: false }], totalXp: 2, leveledUpTo: 1 },
    global: buildGlobalState(),
  })) as unknown as ActivityHarvestDeps["harvestPlayerCrops"];
  const getPlayer = mock.fn(async (_playerId: string) => harvestedPlayer) as unknown as ActivityHarvestDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivityHarvestDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildHarvestDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    harvestPlayerCrops,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakePlantReq("Bearer real-discord-token", {});
  const res = buildFakeRes();

  await handleActivityHarvest(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal((harvestPlayerCrops as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((harvestPlayerCrops as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.status.mock.calls.length, 0, "pas d'erreur : 200 implicite via res.json");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ plots: { index: number; empty?: boolean }[]; inventory: Record<string, number>; xp: number; totalHarvested: number }];
  assert.equal(payload.plots[0]!.empty, true, "la parcelle recoltee doit redevenir vide dans la reponse");
  assert.equal(payload.inventory.wheat, 9, "l'inventaire doit refleter l'etat Postgres post-recolte");
  assert.equal(payload.xp, 12);
  assert.equal(payload.totalHarvested, 16);
});

// ===========================================================================
// TEST 2 -- joueur non allowliste
// ===========================================================================

test("POST /activity/harvest -- TEST 2 : joueur non allowliste -> chemin JSON V1 conserve, harvestPlayerCrops (Postgres) jamais appele", async () => {
  const jsonMutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    const player = buildPlayerState({ plots: [{ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false }] });
    mutator(player);
    return player;
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildHarvestDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityHarvestDeps["ensurePlayerExists"],
    harvestPlayerCrops: mock.fn(async () => {
      throw new Error("harvestPlayerCrops (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityHarvestDeps["harvestPlayerCrops"],
    getPlayer: mock.fn(async () => {
      throw new Error("getPlayer (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityHarvestDeps["getPlayer"],
    getGlobalState: mock.fn(async () => {
      throw new Error("getGlobalState (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityHarvestDeps["getGlobalState"],
  });
  const req = buildFakePlantReq("Bearer real-discord-token", {});
  const res = buildFakeRes();

  await handleActivityHarvest(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange, real harvest() applique");
  assert.equal(jsonMutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(res.json.mock.calls.length, 1);
});

// ===========================================================================
// TEST 3 -- aucune parcelle prete : meme statut/message que le chemin JSON
// ===========================================================================

test("POST /activity/harvest -- TEST 3 : joueur allowliste, aucune parcelle prete -> 400 avec le MEME message que le chemin JSON, aucun repli JSON", async () => {
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildHarvestDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    harvestPlayerCrops: mock.fn(async () => ({
      result: { harvested: [], totalXp: 0, leveledUpTo: 1 },
      global: buildGlobalState(),
    })) as unknown as ActivityHarvestDeps["harvestPlayerCrops"],
  });
  const req = buildFakePlantReq("Bearer real-discord-token", {});
  const res = buildFakeRes();

  await handleActivityHarvest(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls.length, 1);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 400);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Aucune parcelle n'est prête pour le moment.", "message identique au chemin JSON V1, aucune difference semantique Activity/slash command");
});

// ===========================================================================
// TEST 4 -- coherence read-after-write : POST /harvest puis GET /me
// ===========================================================================

test("POST /activity/harvest puis GET /activity/me -- TEST 4 : meme etat de parcelle/inventaire des deux cotes pour un joueur allowliste", async () => {
  // Simule une "table Postgres" en memoire, mutee par le mock
  // harvestPlayerCrops exactement comme le ferait la vraie primitive
  // (farmPlayerActions.ts -> mutatePlayerAndGlobal -> harvest()), puis
  // relue par les DEUX resolveurs (harvest et me) via le meme getPlayer.
  const pgPlayerState = buildPlayerState({
    plots: [{ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false }],
    inventory: {},
  });
  const pgGlobal = buildGlobalState();
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityHarvestDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityHarvestDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const harvestPlayerCrops = mock.fn(async (_playerId: string) => {
    pgPlayerState.plots[0] = { cropId: null, plantedAt: null, notifiedReady: false };
    pgPlayerState.inventory.wheat = (pgPlayerState.inventory.wheat ?? 0) + 4;
    return {
      result: { harvested: [{ cropId: "wheat" as const, amount: 4, xp: 2, replanted: false }], totalXp: 2, leveledUpTo: 1 },
      global: pgGlobal,
    };
  }) as unknown as ActivityHarvestDeps["harvestPlayerCrops"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivityHarvestDeps["ensurePlayerExists"];

  const harvestOutcome = await resolveActivityHarvest(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, harvestPlayerCrops, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );
  assert.equal(harvestOutcome.status, 200);

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  const harvestPayload = harvestOutcome.status === 200 ? harvestOutcome.payload : null;
  assert.ok(harvestPayload);
  assert.deepEqual(
    meResult.plots[0],
    harvestPayload.plots[0],
    "GET /activity/me juste apres POST /activity/harvest doit refleter EXACTEMENT le meme etat de parcelle -- plus de decalage entre les deux routes",
  );
  assert.equal(meResult.plots[0]!.empty, true);
  assert.deepEqual(meResult.inventory, harvestPayload.inventory);
  assert.equal(meResult.inventory.wheat, 4);
});

// ===========================================================================
// LOT ACTIVITY-PG3 -- POST /activity/sell
// ===========================================================================

function buildSellDeps(overrides: Partial<ActivitySellDeps> = {}): ActivitySellDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivitySellDeps["ensurePlayerExists"],
    sellPlayerItems: mock.fn(async (_playerId: string, _itemId: string, _amount: number | null) => ({
      result: { earned: 0, sold: {} },
      global: buildGlobalState(),
    })) as unknown as ActivitySellDeps["sellPlayerItems"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivitySellDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivitySellDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakeSellReq(authHeader: string | undefined, body: unknown): { headers: { authorization: string | undefined }; body: unknown } {
  return { headers: { authorization: authHeader }, body };
}

// ===========================================================================
// TEST 1 -- joueur allowliste Postgres
// ===========================================================================

test("POST /activity/sell -- TEST 1 : joueur allowliste -> ensurePlayerExists + sellPlayerItems + getPlayer + getGlobalState Postgres, store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const soldPlayer = buildPlayerState({
    coins: 260,
    inventory: { wheat: 1 },
  });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: soldPlayer, created: false })) as unknown as ActivitySellDeps["ensurePlayerExists"];
  const sellPlayerItems = mock.fn(async (_playerId: string, _itemId: string, _amount: number | null) => ({
    result: { earned: 60, sold: { wheat: 4 } },
    global: buildGlobalState(),
  })) as unknown as ActivitySellDeps["sellPlayerItems"];
  const getPlayer = mock.fn(async (_playerId: string) => soldPlayer) as unknown as ActivitySellDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivitySellDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildSellDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    sellPlayerItems,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakeSellReq("Bearer real-discord-token", { itemId: "wheat", amount: 4 });
  const res = buildFakeRes();

  await handleActivitySell(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal((sellPlayerItems as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.deepEqual((sellPlayerItems as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments, [TEST_PLAYER_ID, "wheat", 4]);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.status.mock.calls.length, 0, "pas d'erreur : 200 implicite via res.json");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ coins: number; inventory: Record<string, number> }];
  assert.equal(payload.coins, 260, "les coins doivent refleter l'etat Postgres post-vente");
  assert.equal(payload.inventory.wheat, 1, "l'inventaire doit refleter l'etat Postgres post-vente");
});

// ===========================================================================
// TEST 2 -- joueur non allowliste
// ===========================================================================

test("POST /activity/sell -- TEST 2 : joueur non allowliste -> chemin JSON V1 conserve, sellPlayerItems (Postgres) jamais appele", async () => {
  const jsonMutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    const player = buildPlayerState({ coins: 200, inventory: { wheat: 5 } });
    mutator(player);
    return player;
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildSellDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivitySellDeps["ensurePlayerExists"],
    sellPlayerItems: mock.fn(async () => {
      throw new Error("sellPlayerItems (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivitySellDeps["sellPlayerItems"],
    getPlayer: mock.fn(async () => {
      throw new Error("getPlayer (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivitySellDeps["getPlayer"],
    getGlobalState: mock.fn(async () => {
      throw new Error("getGlobalState (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivitySellDeps["getGlobalState"],
  });
  const req = buildFakeSellReq("Bearer real-discord-token", { itemId: "wheat", amount: 2 });
  const res = buildFakeRes();

  await handleActivitySell(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange, real sell() applique");
  assert.equal(jsonMutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(res.json.mock.calls.length, 1);
});

// ===========================================================================
// TEST 3 -- inventaire insuffisant / quantite invalide : meme FarmError
// ===========================================================================

test("POST /activity/sell -- TEST 3 : joueur allowliste, sellPlayerItems (Postgres) rejette avec FarmError -> 400 avec le meme message, aucun repli JSON", async () => {
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildSellDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    sellPlayerItems: mock.fn(async () => {
      throw new FarmError("Tu n'as aucune ressource de ce type à vendre.");
    }) as unknown as ActivitySellDeps["sellPlayerItems"],
  });
  const req = buildFakeSellReq("Bearer real-discord-token", { itemId: "wheat", amount: 999 });
  const res = buildFakeRes();

  await handleActivitySell(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls.length, 1);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 400, "meme statut que le chemin JSON pour une FarmError -- semantique d'erreur inchangee");
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Tu n'as aucune ressource de ce type à vendre.");
});

// ===========================================================================
// TEST 4 -- coherence read-after-write : POST /sell puis GET /me
// ===========================================================================

test("POST /activity/sell puis GET /activity/me -- TEST 4 : memes coins et meme inventaire des deux cotes pour un joueur allowliste", async () => {
  // Simule une "table Postgres" en memoire, mutee par le mock
  // sellPlayerItems exactement comme le ferait la vraie primitive
  // (farmPlayerActions.ts -> mutatePlayerAndGlobal -> sell()), puis relue
  // par les DEUX resolveurs (sell et me) via le meme getPlayer.
  const pgPlayerState = buildPlayerState({ coins: 200, inventory: { wheat: 5 } });
  const pgGlobal = buildGlobalState();
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivitySellDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivitySellDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const sellPlayerItems = mock.fn(async (_playerId: string, itemId: InventoryId | "all", amount: number | null) => {
    const sold = Math.min(amount ?? 0, pgPlayerState.inventory[itemId as InventoryId] ?? 0);
    pgPlayerState.inventory[itemId as InventoryId] = (pgPlayerState.inventory[itemId as InventoryId] ?? 0) - sold;
    pgPlayerState.coins += sold * 15;
    return { result: { earned: sold * 15, sold: { [itemId]: sold } }, global: pgGlobal };
  }) as unknown as ActivitySellDeps["sellPlayerItems"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivitySellDeps["ensurePlayerExists"];

  const sellResult = await resolveActivitySell(
    { id: TEST_PLAYER_ID, username: "tester" },
    "wheat",
    3,
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, sellPlayerItems, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.equal(meResult.coins, sellResult.coins, "GET /activity/me juste apres POST /activity/sell doit refleter EXACTEMENT les memes coins");
  assert.deepEqual(meResult.inventory, sellResult.inventory, "GET /activity/me juste apres POST /activity/sell doit refleter EXACTEMENT le meme inventaire");
  assert.equal(meResult.coins, 245);
  assert.equal(meResult.inventory.wheat, 2);
});

// ===========================================================================
// LOT ACTIVITY-PG3 -- POST /activity/buy
// ===========================================================================

function buildBuyDeps(overrides: Partial<ActivityBuyDeps> = {}): ActivityBuyDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivityBuyDeps["ensurePlayerExists"],
    buyPlayerUpgrade: mock.fn(async (_playerId: string, _kind: "plots" | "irrigation" | "fertilizer", _quantity: number) => ({
      bought: 0,
      spent: 0,
    })) as unknown as ActivityBuyDeps["buyPlayerUpgrade"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivityBuyDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityBuyDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakeBuyReq(authHeader: string | undefined, body: unknown): { headers: { authorization: string | undefined }; body: unknown } {
  return { headers: { authorization: authHeader }, body };
}

// ===========================================================================
// TEST 1 -- achat parcelle Postgres
// ===========================================================================

test("POST /activity/buy -- TEST 1 : joueur allowliste, kind=plots -> ensurePlayerExists + buyPlayerUpgrade + getPlayer + getGlobalState Postgres, store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const boughtPlayer = buildPlayerState({
    coins: 80,
    plots: [
      { cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
    ],
  });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: boughtPlayer, created: false })) as unknown as ActivityBuyDeps["ensurePlayerExists"];
  const buyPlayerUpgrade = mock.fn(async (_playerId: string, _kind: "plots" | "irrigation" | "fertilizer", _quantity: number) => ({
    bought: 1,
    spent: 120,
  })) as unknown as ActivityBuyDeps["buyPlayerUpgrade"];
  const getPlayer = mock.fn(async (_playerId: string) => boughtPlayer) as unknown as ActivityBuyDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivityBuyDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildBuyDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    buyPlayerUpgrade,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakeBuyReq("Bearer real-discord-token", { kind: "plots", quantity: 1 });
  const res = buildFakeRes();

  await handleActivityBuy(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal((buyPlayerUpgrade as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.deepEqual((buyPlayerUpgrade as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments, [TEST_PLAYER_ID, "plots", 1]);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.status.mock.calls.length, 0, "pas d'erreur : 200 implicite via res.json");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ coins: number; plots: unknown[] }];
  assert.equal(payload.coins, 80, "les coins doivent refleter l'etat Postgres post-achat");
  assert.equal(payload.plots.length, 3, "le nombre de parcelles doit refleter l'etat Postgres post-achat");
});

// ===========================================================================
// TEST 2 -- achat irrigation Postgres
// ===========================================================================

test("POST /activity/buy -- TEST 2 : joueur allowliste, kind=irrigation -> niveau irrigation augmente, coins diminuent, payload a jour", async () => {
  const boughtPlayer = buildPlayerState({ coins: 0, irrigationLevel: 2 });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: boughtPlayer, created: false })) as unknown as ActivityBuyDeps["ensurePlayerExists"];
  const buyPlayerUpgrade = mock.fn(async (_playerId: string, _kind: "plots" | "irrigation" | "fertilizer", _quantity: number) => ({
    bought: 1,
    spent: 200,
  })) as unknown as ActivityBuyDeps["buyPlayerUpgrade"];
  const getPlayer = mock.fn(async (_playerId: string) => boughtPlayer) as unknown as ActivityBuyDeps["getPlayer"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildBuyDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    buyPlayerUpgrade,
    getPlayer,
  });
  const req = buildFakeBuyReq("Bearer real-discord-token", { kind: "irrigation", quantity: 1 });
  const res = buildFakeRes();

  await handleActivityBuy(req as never, res as never, deps);

  assert.deepEqual((buyPlayerUpgrade as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments, [TEST_PLAYER_ID, "irrigation", 1]);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ coins: number; irrigationLevel: number }];
  assert.equal(payload.coins, 0);
  assert.equal(payload.irrigationLevel, 2);
});

// ===========================================================================
// TEST 3 -- achat engrais Postgres
// ===========================================================================

test("POST /activity/buy -- TEST 3 : joueur allowliste, kind=fertilizer -> niveau engrais augmente, coins diminuent, payload a jour", async () => {
  const boughtPlayer = buildPlayerState({ coins: 0, fertilizerLevel: 1 });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: boughtPlayer, created: false })) as unknown as ActivityBuyDeps["ensurePlayerExists"];
  const buyPlayerUpgrade = mock.fn(async (_playerId: string, _kind: "plots" | "irrigation" | "fertilizer", _quantity: number) => ({
    bought: 1,
    spent: 200,
  })) as unknown as ActivityBuyDeps["buyPlayerUpgrade"];
  const getPlayer = mock.fn(async (_playerId: string) => boughtPlayer) as unknown as ActivityBuyDeps["getPlayer"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildBuyDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    buyPlayerUpgrade,
    getPlayer,
  });
  const req = buildFakeBuyReq("Bearer real-discord-token", { kind: "fertilizer", quantity: 1 });
  const res = buildFakeRes();

  await handleActivityBuy(req as never, res as never, deps);

  assert.deepEqual((buyPlayerUpgrade as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments, [TEST_PLAYER_ID, "fertilizer", 1]);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ coins: number; fertilizerLevel: number }];
  assert.equal(payload.coins, 0);
  assert.equal(payload.fertilizerLevel, 1);
});

// ===========================================================================
// TEST 4 -- joueur non allowliste
// ===========================================================================

test("POST /activity/buy -- TEST 4 : joueur non allowliste -> chemin JSON V1 conserve, buyPlayerUpgrade (Postgres) jamais appele", async () => {
  const jsonMutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    const player = buildPlayerState({ coins: 200 });
    mutator(player);
    return player;
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildBuyDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityBuyDeps["ensurePlayerExists"],
    buyPlayerUpgrade: mock.fn(async () => {
      throw new Error("buyPlayerUpgrade (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityBuyDeps["buyPlayerUpgrade"],
    getPlayer: mock.fn(async () => {
      throw new Error("getPlayer (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityBuyDeps["getPlayer"],
    getGlobalState: mock.fn(async () => {
      throw new Error("getGlobalState (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityBuyDeps["getGlobalState"],
  });
  const req = buildFakeBuyReq("Bearer real-discord-token", { kind: "plots", quantity: 1 });
  const res = buildFakeRes();

  await handleActivityBuy(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange, real buyUpgrade() applique");
  assert.equal(jsonMutatePlayer.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(res.json.mock.calls.length, 1);
});

// ===========================================================================
// TEST 5 -- achat impossible : meme FarmError
// ===========================================================================

test("POST /activity/buy -- TEST 5 : joueur allowliste, buyPlayerUpgrade (Postgres) rejette avec FarmError -> 400 avec le meme message, aucun repli JSON", async () => {
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildBuyDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    buyPlayerUpgrade: mock.fn(async () => {
      throw new FarmError("Achat impossible : niveau maximum atteint ou pièces insuffisantes.");
    }) as unknown as ActivityBuyDeps["buyPlayerUpgrade"],
  });
  const req = buildFakeBuyReq("Bearer real-discord-token", { kind: "plots", quantity: 1 });
  const res = buildFakeRes();

  await handleActivityBuy(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls.length, 1);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 400, "meme statut que le chemin JSON pour une FarmError -- semantique d'erreur inchangee");
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Achat impossible : niveau maximum atteint ou pièces insuffisantes.");
});

test("POST /activity/buy -- TEST 5bis : kind absent -> 400 'Amélioration invalide', identique aux deux chemins, aucune primitive appelee", async () => {
  const deps = buildBuyDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists ne doit jamais etre appele si kind est absent");
    }) as unknown as ActivityBuyDeps["ensurePlayerExists"],
    buyPlayerUpgrade: mock.fn(async () => {
      throw new Error("buyPlayerUpgrade ne doit jamais etre appele si kind est absent");
    }) as unknown as ActivityBuyDeps["buyPlayerUpgrade"],
  });
  const req = buildFakeBuyReq("Bearer real-discord-token", {});
  const res = buildFakeRes();

  await handleActivityBuy(req as never, res as never, deps);

  assert.equal(res.status.mock.calls[0]!.arguments[0], 400);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Amélioration invalide");
});

// ===========================================================================
// TEST 6 -- coherence read-after-write : POST /buy puis GET /me
// ===========================================================================

test("POST /activity/buy puis GET /activity/me -- TEST 6 : memes coins, memes parcelles, meme irrigation et meme engrais des deux cotes pour un joueur allowliste", async () => {
  // Simule une "table Postgres" en memoire, mutee par le mock
  // buyPlayerUpgrade exactement comme le ferait la vraie primitive
  // (farmPlayerActions.ts -> mutatePlayer -> buyUpgrade()), puis relue par
  // les DEUX resolveurs (buy et me) via le meme getPlayer.
  const pgPlayerState = buildPlayerState({ coins: 500, irrigationLevel: 1, fertilizerLevel: 0 });
  const pgGlobal = buildGlobalState();
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityBuyDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityBuyDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const buyPlayerUpgrade = mock.fn(async (_playerId: string, kind: "plots" | "irrigation" | "fertilizer", _quantity: number) => {
    const cost = 200;
    pgPlayerState.coins -= cost;
    if (kind === "irrigation") {
      pgPlayerState.irrigationLevel += 1;
    } else if (kind === "fertilizer") {
      pgPlayerState.fertilizerLevel += 1;
    } else {
      pgPlayerState.plots.push({ cropId: null, plantedAt: null, notifiedReady: false });
    }
    return { bought: 1, spent: cost };
  }) as unknown as ActivityBuyDeps["buyPlayerUpgrade"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivityBuyDeps["ensurePlayerExists"];

  const buyResult = await resolveActivityBuy(
    { id: TEST_PLAYER_ID, username: "tester" },
    "irrigation",
    1,
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, buyPlayerUpgrade, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.equal(meResult.coins, buyResult.coins, "GET /activity/me juste apres POST /activity/buy doit refleter EXACTEMENT les memes coins");
  assert.equal(meResult.plots.length, buyResult.plots.length, "meme nombre de parcelles des deux cotes");
  assert.equal(meResult.irrigationLevel, buyResult.irrigationLevel, "meme niveau d'irrigation des deux cotes");
  assert.equal(meResult.fertilizerLevel, buyResult.fertilizerLevel, "meme niveau d'engrais des deux cotes");
  assert.equal(meResult.coins, 300);
  assert.equal(meResult.irrigationLevel, 2);
});

// ===========================================================================
// LOT ACTIVITY-PG4 -- POST /activity/craft
// ===========================================================================

function buildCraftDeps(overrides: Partial<ActivityCraftDeps> = {}): ActivityCraftDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivityCraftDeps["ensurePlayerExists"],
    craftPlayerItem: mock.fn(async (_playerId: string, _recipeId: ProductId, _quantity: number) => 0) as unknown as ActivityCraftDeps["craftPlayerItem"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivityCraftDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityCraftDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakeCraftReq(authHeader: string | undefined, body: unknown): { headers: { authorization: string | undefined }; body: unknown } {
  return { headers: { authorization: authHeader }, body };
}

test("POST /activity/craft -- TEST 1 : joueur allowliste -> ensurePlayerExists + craftPlayerItem + getPlayer + getGlobalState Postgres, store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const craftedPlayer = buildPlayerState({ inventory: { wheat: 2, bread: 1 } });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: craftedPlayer, created: false })) as unknown as ActivityCraftDeps["ensurePlayerExists"];
  const craftPlayerItem = mock.fn(async (_playerId: string, _recipeId: ProductId, _quantity: number) => 1) as unknown as ActivityCraftDeps["craftPlayerItem"];
  const getPlayer = mock.fn(async (_playerId: string) => craftedPlayer) as unknown as ActivityCraftDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivityCraftDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildCraftDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    craftPlayerItem,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakeCraftReq("Bearer real-discord-token", { recipeId: "bread", quantity: 1 });
  const res = buildFakeRes();

  await handleActivityCraft(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((craftPlayerItem as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.deepEqual((craftPlayerItem as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments, [TEST_PLAYER_ID, "bread", 1]);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ inventory: Record<string, number> }];
  assert.equal(payload.inventory.bread, 1, "l'inventaire doit refleter l'etat Postgres post-craft");
  assert.equal(payload.inventory.wheat, 2);
});

test("POST /activity/craft -- TEST 2 : joueur non allowliste -> chemin JSON V1 conserve, craftPlayerItem (Postgres) jamais appele", async () => {
  const jsonMutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    const player = buildPlayerState({ inventory: { wheat: 3 } });
    mutator(player);
    return player;
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildCraftDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityCraftDeps["ensurePlayerExists"],
    craftPlayerItem: mock.fn(async () => {
      throw new Error("craftPlayerItem (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityCraftDeps["craftPlayerItem"],
  });
  const req = buildFakeCraftReq("Bearer real-discord-token", { recipeId: "bread", quantity: 1 });
  const res = buildFakeRes();

  await handleActivityCraft(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange, real craft() applique");
  assert.equal(res.json.mock.calls.length, 1);
});

test("POST /activity/craft -- TEST 3 : joueur allowliste, craftPlayerItem (Postgres) rejette avec FarmError -> 400 avec le meme message, aucun repli JSON", async () => {
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildCraftDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    craftPlayerItem: mock.fn(async () => {
      throw new FarmError("Tu n'as pas assez de cultures pour cette recette.");
    }) as unknown as ActivityCraftDeps["craftPlayerItem"],
  });
  const req = buildFakeCraftReq("Bearer real-discord-token", { recipeId: "bread", quantity: 5 });
  const res = buildFakeRes();

  await handleActivityCraft(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 400);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Tu n'as pas assez de cultures pour cette recette.");
});

test("POST /activity/craft -- TEST 4 : recipeId absent -> 400 'Recette invalide', aucune primitive appelee", async () => {
  const deps = buildCraftDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists ne doit jamais etre appele si recipeId est absent");
    }) as unknown as ActivityCraftDeps["ensurePlayerExists"],
    craftPlayerItem: mock.fn(async () => {
      throw new Error("craftPlayerItem ne doit jamais etre appele si recipeId est absent");
    }) as unknown as ActivityCraftDeps["craftPlayerItem"],
  });
  const req = buildFakeCraftReq("Bearer real-discord-token", {});
  const res = buildFakeRes();

  await handleActivityCraft(req as never, res as never, deps);

  assert.equal(res.status.mock.calls[0]!.arguments[0], 400);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Recette invalide");
});

test("POST /activity/craft puis GET /activity/me -- TEST 5 : meme inventaire des deux cotes pour un joueur allowliste", async () => {
  const pgPlayerState = buildPlayerState({ inventory: { wheat: 6 } });
  const pgGlobal = buildGlobalState();
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityCraftDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityCraftDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const craftPlayerItem = mock.fn(async (_playerId: string, recipeId: ProductId, quantity: number) => {
    pgPlayerState.inventory.wheat = (pgPlayerState.inventory.wheat ?? 0) - 3 * quantity;
    pgPlayerState.inventory[recipeId] = (pgPlayerState.inventory[recipeId] ?? 0) + quantity;
    return quantity;
  }) as unknown as ActivityCraftDeps["craftPlayerItem"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivityCraftDeps["ensurePlayerExists"];

  const craftResult = await resolveActivityCraft(
    { id: TEST_PLAYER_ID, username: "tester" },
    "bread",
    1,
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, craftPlayerItem, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.deepEqual(meResult.inventory, craftResult.inventory, "GET /activity/me juste apres POST /activity/craft doit refleter EXACTEMENT le meme inventaire");
  assert.equal(meResult.inventory.wheat, 3);
  assert.equal(meResult.inventory.bread, 1);
});

// LOT ACTIVITY-UX-QUANTITIES -- le frontend peut desormais envoyer une
// quantite > 1 en UNE seule requete (selecteur [ - ][ n ][ + ][ MAX ]) :
// verifie que le body est transmis tel quel a craftPlayerItem(), sans
// aucune transformation/plafonnement cote route (craft() de farm.ts reste
// seul responsable de la validation reelle -- 1-40, ingredients
// suffisants).
test("POST /activity/craft -- TEST 6 : quantity > 1 (selecteur frontend) -> transmise telle quelle a craftPlayerItem(), payload reflete la quantite produite", async () => {
  const craftedPlayer = buildPlayerState({ inventory: { wheat: 1, bread: 5 } });
  const craftPlayerItem = mock.fn(async (_playerId: string, _recipeId: ProductId, _quantity: number) => 5) as unknown as ActivityCraftDeps["craftPlayerItem"];
  const getPlayer = mock.fn(async (_playerId: string) => craftedPlayer) as unknown as ActivityCraftDeps["getPlayer"];
  const deps = buildCraftDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    craftPlayerItem,
    getPlayer,
  });
  const req = buildFakeCraftReq("Bearer real-discord-token", { recipeId: "bread", quantity: 5 });
  const res = buildFakeRes();

  await handleActivityCraft(req as never, res as never, deps);

  assert.deepEqual((craftPlayerItem as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments, [TEST_PLAYER_ID, "bread", 5]);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ inventory: Record<string, number> }];
  assert.equal(payload.inventory.bread, 5);
});

// ===========================================================================
// LOT ACTIVITY-PG4 -- POST /activity/daily
// ===========================================================================

function buildDailyDeps(overrides: Partial<ActivityDailyDeps> = {}): ActivityDailyDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivityDailyDeps["ensurePlayerExists"],
    claimPlayerDaily: mock.fn(async (_playerId: string) => 0) as unknown as ActivityDailyDeps["claimPlayerDaily"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivityDailyDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityDailyDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakeDailyReq(authHeader: string | undefined): { headers: { authorization: string | undefined }; body: unknown } {
  return { headers: { authorization: authHeader }, body: {} };
}

test("POST /activity/daily -- TEST 1 : joueur allowliste -> ensurePlayerExists + claimPlayerDaily + getPlayer + getGlobalState Postgres, store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const rewardedPlayer = buildPlayerState({ coins: 246, lastDailyAt: NOW });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: rewardedPlayer, created: false })) as unknown as ActivityDailyDeps["ensurePlayerExists"];
  const claimPlayerDaily = mock.fn(async (_playerId: string) => 46) as unknown as ActivityDailyDeps["claimPlayerDaily"];
  const getPlayer = mock.fn(async (_playerId: string) => rewardedPlayer) as unknown as ActivityDailyDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivityDailyDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildDailyDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    claimPlayerDaily,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakeDailyReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleActivityDaily(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((claimPlayerDaily as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((claimPlayerDaily as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ coins: number }];
  assert.equal(payload.coins, 246, "les coins doivent refleter l'etat Postgres post-reclamation");
});

test("POST /activity/daily -- TEST 2 : joueur non allowliste -> chemin JSON V1 conserve, claimPlayerDaily (Postgres) jamais appele", async () => {
  const jsonMutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    const player = buildPlayerState({ coins: 200, lastDailyAt: null });
    mutator(player);
    return player;
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildDailyDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityDailyDeps["ensurePlayerExists"],
    claimPlayerDaily: mock.fn(async () => {
      throw new Error("claimPlayerDaily (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityDailyDeps["claimPlayerDaily"],
  });
  const req = buildFakeDailyReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleActivityDaily(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange, real claimDaily() applique");
  assert.equal(res.json.mock.calls.length, 1);
});

test("POST /activity/daily -- TEST 3 : joueur allowliste, cooldown actif -> 400 avec le meme message, aucun repli JSON", async () => {
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildDailyDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    claimPlayerDaily: mock.fn(async () => {
      throw new FarmError("Ta récompense revient dans environ 5 h.");
    }) as unknown as ActivityDailyDeps["claimPlayerDaily"],
  });
  const req = buildFakeDailyReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleActivityDaily(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 400);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Ta récompense revient dans environ 5 h.");
});

test("POST /activity/daily puis GET /activity/me -- TEST 4 : memes coins des deux cotes pour un joueur allowliste", async () => {
  const pgPlayerState = buildPlayerState({ coins: 200, level: 3, lastDailyAt: null });
  const pgGlobal = buildGlobalState();
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityDailyDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityDailyDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const claimPlayerDaily = mock.fn(async (_playerId: string) => {
    const reward = 40 + pgPlayerState.level * 2;
    pgPlayerState.coins += reward;
    pgPlayerState.lastDailyAt = NOW;
    return reward;
  }) as unknown as ActivityDailyDeps["claimPlayerDaily"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivityDailyDeps["ensurePlayerExists"];

  const dailyResult = await resolveActivityDaily(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, claimPlayerDaily, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.equal(meResult.coins, dailyResult.coins, "GET /activity/me juste apres POST /activity/daily doit refleter EXACTEMENT les memes coins");
  assert.equal(meResult.coins, 246);
});

// ===========================================================================
// LOT ACTIVITY-PG4 -- POST /activity/quest-claim
// ===========================================================================

function buildQuest(overrides: Partial<QuestProgress> = {}): QuestProgress {
  return {
    type: "harvest",
    label: "Récolter 10 cultures",
    target: 10,
    progress: 10,
    rewardCoins: 50,
    claimed: false,
    ...overrides,
  };
}

function buildQuestClaimDeps(overrides: Partial<ActivityQuestClaimDeps> = {}): ActivityQuestClaimDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivityQuestClaimDeps["ensurePlayerExists"],
    claimPlayerQuest: mock.fn(async (_playerId: string, _questIndex: number) => 0) as unknown as ActivityQuestClaimDeps["claimPlayerQuest"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivityQuestClaimDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityQuestClaimDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakeQuestClaimReq(authHeader: string | undefined, body: unknown): { headers: { authorization: string | undefined }; body: unknown } {
  return { headers: { authorization: authHeader }, body };
}

test("POST /activity/quest-claim -- TEST 1 : joueur allowliste -> ensurePlayerExists + claimPlayerQuest + getPlayer + getGlobalState Postgres, store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const claimedQuest = buildQuest({ claimed: true });
  const rewardedPlayer = buildPlayerState({ coins: 250, quests: [claimedQuest] });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: rewardedPlayer, created: false })) as unknown as ActivityQuestClaimDeps["ensurePlayerExists"];
  const claimPlayerQuest = mock.fn(async (_playerId: string, _questIndex: number) => 50) as unknown as ActivityQuestClaimDeps["claimPlayerQuest"];
  const getPlayer = mock.fn(async (_playerId: string) => rewardedPlayer) as unknown as ActivityQuestClaimDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivityQuestClaimDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildQuestClaimDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    claimPlayerQuest,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakeQuestClaimReq("Bearer real-discord-token", { questIndex: 0 });
  const res = buildFakeRes();

  await handleActivityQuestClaim(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((claimPlayerQuest as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.deepEqual((claimPlayerQuest as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments, [TEST_PLAYER_ID, 0]);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ coins: number; quests: QuestProgress[] }];
  assert.equal(payload.coins, 250, "les coins doivent refleter l'etat Postgres post-reclamation");
  assert.equal(payload.quests[0]!.claimed, true);
});

test("POST /activity/quest-claim -- TEST 2 : joueur non allowliste -> chemin JSON V1 conserve, claimPlayerQuest (Postgres) jamais appele", async () => {
  const jsonMutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    const player = buildPlayerState({ coins: 200, quests: [buildQuest()] });
    mutator(player);
    return player;
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildQuestClaimDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityQuestClaimDeps["ensurePlayerExists"],
    claimPlayerQuest: mock.fn(async () => {
      throw new Error("claimPlayerQuest (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityQuestClaimDeps["claimPlayerQuest"],
  });
  const req = buildFakeQuestClaimReq("Bearer real-discord-token", { questIndex: 0 });
  const res = buildFakeRes();

  await handleActivityQuestClaim(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange, real claimQuest() applique");
  assert.equal(res.json.mock.calls.length, 1);
});

test("POST /activity/quest-claim -- TEST 3 : joueur allowliste, mission deja reclamee -> 400 avec le meme message, aucun repli JSON", async () => {
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildQuestClaimDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    claimPlayerQuest: mock.fn(async () => {
      throw new FarmError("Cette mission a déjà été récupérée.");
    }) as unknown as ActivityQuestClaimDeps["claimPlayerQuest"],
  });
  const req = buildFakeQuestClaimReq("Bearer real-discord-token", { questIndex: 0 });
  const res = buildFakeRes();

  await handleActivityQuestClaim(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 400);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Cette mission a déjà été récupérée.");
});

test("POST /activity/quest-claim puis GET /activity/me -- TEST 4 : memes coins et meme etat de quete des deux cotes pour un joueur allowliste", async () => {
  const pgPlayerState = buildPlayerState({ coins: 200, quests: [buildQuest()] });
  const pgGlobal = buildGlobalState();
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityQuestClaimDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityQuestClaimDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const claimPlayerQuest = mock.fn(async (_playerId: string, questIndex: number) => {
    const quest = pgPlayerState.quests[questIndex]!;
    quest.claimed = true;
    pgPlayerState.coins += quest.rewardCoins;
    return quest.rewardCoins;
  }) as unknown as ActivityQuestClaimDeps["claimPlayerQuest"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivityQuestClaimDeps["ensurePlayerExists"];

  const questResult = await resolveActivityQuestClaim(
    { id: TEST_PLAYER_ID, username: "tester" },
    0,
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, claimPlayerQuest, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.equal(meResult.coins, questResult.coins, "GET /activity/me juste apres POST /activity/quest-claim doit refleter EXACTEMENT les memes coins");
  assert.deepEqual(meResult.quests, questResult.quests, "GET /activity/me juste apres POST /activity/quest-claim doit refleter EXACTEMENT le meme etat de quete");
  assert.equal(meResult.coins, 250);
  assert.equal(meResult.quests[0]!.claimed, true);
});

// ===========================================================================
// LOT ACTIVITY-PG4 -- POST /activity/skin
// ===========================================================================

function buildSkinDeps(overrides: Partial<ActivitySkinDeps> = {}): ActivitySkinDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivitySkinDeps["ensurePlayerExists"],
    choosePlayerSkin: mock.fn(async (_playerId: string, _skinId: PlotSkinId) => buildPlayerState()) as unknown as ActivitySkinDeps["choosePlayerSkin"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivitySkinDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakeSkinReq(authHeader: string | undefined, body: unknown): { headers: { authorization: string | undefined }; body: unknown } {
  return { headers: { authorization: authHeader }, body };
}

test("POST /activity/skin -- TEST 1 : joueur allowliste -> ensurePlayerExists + choosePlayerSkin + getGlobalState Postgres (PAS de getPlayer separe, choosePlayerSkin renvoie deja le player), store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const skinnedPlayer = buildPlayerState({ level: 10, plotSkin: "autumn", unlockedSkins: ["classic", "autumn"] });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: skinnedPlayer, created: false })) as unknown as ActivitySkinDeps["ensurePlayerExists"];
  const choosePlayerSkin = mock.fn(async (_playerId: string, _skinId: PlotSkinId) => skinnedPlayer) as unknown as ActivitySkinDeps["choosePlayerSkin"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivitySkinDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildSkinDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    choosePlayerSkin,
    getGlobalState,
  });
  const req = buildFakeSkinReq("Bearer real-discord-token", { skinId: "autumn" });
  const res = buildFakeRes();

  await handleActivitySkin(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((choosePlayerSkin as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.deepEqual((choosePlayerSkin as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments, [TEST_PLAYER_ID, "autumn"]);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ plotSkin: string }];
  assert.equal(payload.plotSkin, "autumn", "le theme doit refleter l'etat Postgres post-choix");
});

test("POST /activity/skin -- TEST 2 : joueur non allowliste -> chemin JSON V1 conserve, choosePlayerSkin (Postgres) jamais appele", async () => {
  const jsonMutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    const player = buildPlayerState({ level: 10 });
    mutator(player);
    return player;
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildSkinDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivitySkinDeps["ensurePlayerExists"],
    choosePlayerSkin: mock.fn(async () => {
      throw new Error("choosePlayerSkin (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivitySkinDeps["choosePlayerSkin"],
  });
  const req = buildFakeSkinReq("Bearer real-discord-token", { skinId: "autumn" });
  const res = buildFakeRes();

  await handleActivitySkin(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange, real chooseSkin() applique");
  assert.equal(res.json.mock.calls.length, 1);
});

test("POST /activity/skin -- TEST 3 : joueur allowliste, niveau insuffisant -> 400 avec le meme message, aucun repli JSON", async () => {
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildSkinDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    choosePlayerSkin: mock.fn(async () => {
      throw new FarmError("Ce thème se débloque au niveau 8.");
    }) as unknown as ActivitySkinDeps["choosePlayerSkin"],
  });
  const req = buildFakeSkinReq("Bearer real-discord-token", { skinId: "autumn" });
  const res = buildFakeRes();

  await handleActivitySkin(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 400);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Ce thème se débloque au niveau 8.");
});

test("POST /activity/skin -- TEST 4 : skinId absent -> 400 'Thème invalide', aucune primitive appelee", async () => {
  const deps = buildSkinDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists ne doit jamais etre appele si skinId est absent");
    }) as unknown as ActivitySkinDeps["ensurePlayerExists"],
    choosePlayerSkin: mock.fn(async () => {
      throw new Error("choosePlayerSkin ne doit jamais etre appele si skinId est absent");
    }) as unknown as ActivitySkinDeps["choosePlayerSkin"],
  });
  const req = buildFakeSkinReq("Bearer real-discord-token", {});
  const res = buildFakeRes();

  await handleActivitySkin(req as never, res as never, deps);

  assert.equal(res.status.mock.calls[0]!.arguments[0], 400);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Thème invalide");
});

test("POST /activity/skin puis GET /activity/me -- TEST 5 : meme theme des deux cotes pour un joueur allowliste", async () => {
  const pgPlayerState = buildPlayerState({ level: 10, plotSkin: "classic", unlockedSkins: ["classic"] });
  const pgGlobal = buildGlobalState();
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivitySkinDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityMeDeps["getPlayer"];
  const choosePlayerSkin = mock.fn(async (_playerId: string, skinId: PlotSkinId) => {
    pgPlayerState.plotSkin = skinId;
    if (!pgPlayerState.unlockedSkins.includes(skinId)) pgPlayerState.unlockedSkins.push(skinId);
    return pgPlayerState;
  }) as unknown as ActivitySkinDeps["choosePlayerSkin"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivitySkinDeps["ensurePlayerExists"];

  const skinResult = await resolveActivitySkin(
    { id: TEST_PLAYER_ID, username: "tester" },
    "autumn",
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, choosePlayerSkin, getGlobalState: sharedGetGlobalState },
  );

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.equal(meResult.plotSkin, skinResult.plotSkin, "GET /activity/me juste apres POST /activity/skin doit refleter EXACTEMENT le meme theme");
  assert.equal(meResult.plotSkin, "autumn");
});

// ===========================================================================
// LOT ACTIVITY-PG4 -- POST /activity/forecast
// ===========================================================================

function buildForecastDeps(overrides: Partial<ActivityForecastDeps> = {}): ActivityForecastDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivityForecastDeps["ensurePlayerExists"],
    buyPlayerWeatherForecast: mock.fn(async (_playerId: string) => "rain") as unknown as ActivityForecastDeps["buyPlayerWeatherForecast"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivityForecastDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityForecastDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakeForecastReq(authHeader: string | undefined): { headers: { authorization: string | undefined }; body: unknown } {
  return { headers: { authorization: authHeader }, body: {} };
}

test("POST /activity/forecast -- TEST 1 : joueur allowliste -> ensurePlayerExists + buyPlayerWeatherForecast + getPlayer + getGlobalState Postgres, store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const forecastPlayer = buildPlayerState({ coins: 150, weatherForecast: "rain" });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: forecastPlayer, created: false })) as unknown as ActivityForecastDeps["ensurePlayerExists"];
  const buyPlayerWeatherForecast = mock.fn(async (_playerId: string) => "rain") as unknown as ActivityForecastDeps["buyPlayerWeatherForecast"];
  const getPlayer = mock.fn(async (_playerId: string) => forecastPlayer) as unknown as ActivityForecastDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivityForecastDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildForecastDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    buyPlayerWeatherForecast,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakeForecastReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleActivityForecast(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((buyPlayerWeatherForecast as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((buyPlayerWeatherForecast as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ coins: number }];
  assert.equal(payload.coins, 150, "les coins doivent refleter l'etat Postgres post-achat");
});

test("POST /activity/forecast -- TEST 2 : joueur non allowliste -> chemin JSON V1 conserve, buyPlayerWeatherForecast (Postgres) jamais appele", async () => {
  const jsonMutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    const player = buildPlayerState({ coins: 200 });
    mutator(player);
    return player;
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildForecastDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityForecastDeps["ensurePlayerExists"],
    buyPlayerWeatherForecast: mock.fn(async () => {
      throw new Error("buyPlayerWeatherForecast (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityForecastDeps["buyPlayerWeatherForecast"],
  });
  const req = buildFakeForecastReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleActivityForecast(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange, real buyWeatherForecast() applique");
  assert.equal(res.json.mock.calls.length, 1);
});

test("POST /activity/forecast -- TEST 3 : joueur allowliste, pieces insuffisantes -> 400 avec le meme message, aucun repli JSON", async () => {
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele en cas d'erreur Postgres");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildForecastDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    buyPlayerWeatherForecast: mock.fn(async () => {
      throw new FarmError("Il te faut 30 pièces pour une prévision météo.");
    }) as unknown as ActivityForecastDeps["buyPlayerWeatherForecast"],
  });
  const req = buildFakeForecastReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleActivityForecast(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 0);
  assert.equal(res.status.mock.calls[0]!.arguments[0], 400);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ error: string }];
  assert.equal(payload.error, "Il te faut 30 pièces pour une prévision météo.");
});

test("POST /activity/forecast puis GET /activity/me -- TEST 4 : memes coins des deux cotes pour un joueur allowliste", async () => {
  const pgPlayerState = buildPlayerState({ coins: 200, weatherForecast: null });
  const pgGlobal = buildGlobalState({ nextWeatherType: "pests" });
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityForecastDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityForecastDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const buyPlayerWeatherForecast = mock.fn(async (_playerId: string) => {
    pgPlayerState.coins -= 30;
    pgPlayerState.weatherForecast = pgGlobal.nextWeatherType;
    return pgGlobal.nextWeatherType;
  }) as unknown as ActivityForecastDeps["buyPlayerWeatherForecast"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivityForecastDeps["ensurePlayerExists"];

  const forecastResult = await resolveActivityForecast(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, buyPlayerWeatherForecast, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.equal(meResult.coins, forecastResult.coins, "GET /activity/me juste apres POST /activity/forecast doit refleter EXACTEMENT les memes coins");
  assert.equal(meResult.coins, 170);
});

// ===========================================================================
// LOT ACTIVITY-PG4 -- POST /activity/autoreplant
// ===========================================================================

function buildAutoreplantDeps(overrides: Partial<ActivityAutoreplantDeps> = {}): ActivityAutoreplantDeps {
  return {
    requireDiscordUser: mock.fn(async (_authHeader: string | undefined) => ({ id: TEST_PLAYER_ID, username: "tester" }) as DiscordUser),
    getFarmStore: mock.fn(async () => buildFakeStore()),
    shouldUsePostgresRuntime: mock.fn((_playerId: string) => false),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: buildPlayerState(), created: false })) as unknown as ActivityAutoreplantDeps["ensurePlayerExists"],
    togglePlayerAutoReplant: mock.fn(async (_playerId: string) => true) as unknown as ActivityAutoreplantDeps["togglePlayerAutoReplant"],
    getPlayer: mock.fn(async (_playerId: string) => buildPlayerState()) as unknown as ActivityAutoreplantDeps["getPlayer"],
    getGlobalState: mock.fn(async () => buildGlobalState()) as unknown as ActivityAutoreplantDeps["getGlobalState"],
    ...overrides,
  };
}

function buildFakeAutoreplantReq(authHeader: string | undefined): { headers: { authorization: string | undefined }; body: unknown } {
  return { headers: { authorization: authHeader }, body: {} };
}

test("POST /activity/autoreplant -- TEST 1 : joueur allowliste -> ensurePlayerExists + togglePlayerAutoReplant + getPlayer + getGlobalState Postgres, store.mutatePlayer (JSON) JAMAIS appele", async () => {
  const toggledPlayer = buildPlayerState({ autoReplant: true });
  const ensurePlayerExists = mock.fn(async (_playerId: string) => ({ player: toggledPlayer, created: false })) as unknown as ActivityAutoreplantDeps["ensurePlayerExists"];
  const togglePlayerAutoReplant = mock.fn(async (_playerId: string) => true) as unknown as ActivityAutoreplantDeps["togglePlayerAutoReplant"];
  const getPlayer = mock.fn(async (_playerId: string) => toggledPlayer) as unknown as ActivityAutoreplantDeps["getPlayer"];
  const getGlobalState = mock.fn(async () => buildGlobalState()) as unknown as ActivityAutoreplantDeps["getGlobalState"];
  const jsonMutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer (JSON) ne doit jamais etre appele pour un joueur allowliste");
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildAutoreplantDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists,
    togglePlayerAutoReplant,
    getPlayer,
    getGlobalState,
  });
  const req = buildFakeAutoreplantReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleActivityAutoreplant(req as never, res as never, deps);

  assert.equal((ensurePlayerExists as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((togglePlayerAutoReplant as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((togglePlayerAutoReplant as unknown as ReturnType<typeof mock.fn>).mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal((getPlayer as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal((getGlobalState as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  assert.equal(jsonMutatePlayer.mock.calls.length, 0, "store.mutatePlayer (JSON) ne doit jamais etre appele");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ autoReplant: boolean }];
  assert.equal(payload.autoReplant, true, "le flag doit refleter l'etat Postgres post-bascule");
});

test("POST /activity/autoreplant -- TEST 2 : joueur non allowliste -> chemin JSON V1 conserve (p.autoReplant = !p.autoReplant inline), togglePlayerAutoReplant (Postgres) jamais appele", async () => {
  const jsonMutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    const player = buildPlayerState({ autoReplant: false });
    mutator(player);
    return player;
  });
  const store = { mutatePlayer: jsonMutatePlayer, global: buildGlobalState() } as unknown as FarmStore;
  const deps = buildAutoreplantDeps({
    shouldUsePostgresRuntime: mock.fn(() => false),
    getFarmStore: mock.fn(async () => store),
    ensurePlayerExists: mock.fn(async () => {
      throw new Error("ensurePlayerExists (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityAutoreplantDeps["ensurePlayerExists"],
    togglePlayerAutoReplant: mock.fn(async () => {
      throw new Error("togglePlayerAutoReplant (Postgres) ne doit jamais etre appele pour un joueur non allowliste");
    }) as unknown as ActivityAutoreplantDeps["togglePlayerAutoReplant"],
  });
  const req = buildFakeAutoreplantReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleActivityAutoreplant(req as never, res as never, deps);

  assert.equal(jsonMutatePlayer.mock.calls.length, 1, "store.mutatePlayer (JSON) doit etre appele -- chemin V1 inchange");
  assert.equal(res.json.mock.calls.length, 1);
  const [payload] = res.json.mock.calls[0]!.arguments as [{ autoReplant: boolean }];
  assert.equal(payload.autoReplant, true, "false -> true via le toggle JSON inline inchange");
});

test("POST /activity/autoreplant puis GET /activity/me -- TEST 3 : meme flag des deux cotes pour un joueur allowliste", async () => {
  const pgPlayerState = buildPlayerState({ autoReplant: false });
  const pgGlobal = buildGlobalState();
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityAutoreplantDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityAutoreplantDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const togglePlayerAutoReplant = mock.fn(async (_playerId: string) => {
    pgPlayerState.autoReplant = !pgPlayerState.autoReplant;
    return pgPlayerState.autoReplant;
  }) as unknown as ActivityAutoreplantDeps["togglePlayerAutoReplant"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivityAutoreplantDeps["ensurePlayerExists"];

  const autoreplantResult = await resolveActivityAutoreplant(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, togglePlayerAutoReplant, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  const meResult = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.equal(meResult.autoReplant, autoreplantResult.autoReplant, "GET /activity/me juste apres POST /activity/autoreplant doit refleter EXACTEMENT le meme flag");
  assert.equal(meResult.autoReplant, true);
});

// ===========================================================================
// LOT ACTIVITY-UX-WEATHER -- GET /activity/me : objet `weather` enrichi
// ===========================================================================
//
// Verifie que la fuite de la prochaine meteo (le "bug" signale : le texte
// "Prochaine meteo : ..." affiche cote frontend AVANT tout achat de
// prevision) est bien impossible cote backend : `weather.forecast` doit
// rester `null` tant que `player.weatherForecast` (peuple UNIQUEMENT par
// buyWeatherForecast()/farm.ts, jamais autrement) ne l'est pas.
// `weather.nextChangeAt` (un TIMESTAMP, jamais le type de meteo a venir)
// reste lui TOUJOURS expose -- il ne revele rien sur la prochaine meteo,
// seulement le moment du prochain changement.

test("GET /activity/me -- weather.current reflete EXACTEMENT WEATHER_INFO[global.weather], aucune valeur inventee", async () => {
  const global = buildGlobalState({ weather: "pests", nextWeatherAt: NOW + 522_000 });
  const player = buildPlayerState({ weatherForecast: null });
  const store = buildFakeStore({ player, global });
  const deps = buildDeps({ getFarmStore: mock.fn(async () => store) });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  const [payload] = res.json.mock.calls[0]!.arguments as [{ weather: { current: { key: WeatherKey; label: string; emoji: string; multiplier: number }; nextChangeAt: number; forecastPurchased: boolean; forecast: unknown } }];
  assert.deepEqual(payload.weather.current, { key: "pests", ...WEATHER_INFO.pests }, "current doit venir de WEATHER_INFO, pas d'une valeur codee en dur");
  assert.equal(payload.weather.nextChangeAt, NOW + 522_000, "nextChangeAt = global.nextWeatherAt telle quelle");
});

test("GET /activity/me -- forecast NON achete -> weather.forecast est null et weather.forecastPurchased est false (AUCUNE fuite de la prochaine meteo)", async () => {
  const global = buildGlobalState({ nextWeatherType: "pests" });
  const player = buildPlayerState({ weatherForecast: null });
  const store = buildFakeStore({ player, global });
  const deps = buildDeps({ getFarmStore: mock.fn(async () => store) });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  const [payload] = res.json.mock.calls[0]!.arguments as [{ weather: { forecast: unknown; forecastPurchased: boolean } }];
  assert.equal(payload.weather.forecast, null, "AUCUNE prevision affichee tant qu'elle n'a pas ete achetee");
  assert.equal(payload.weather.forecastPurchased, false);
  assert.equal(JSON.stringify(payload).includes("pests"), false, "le payload entier ne doit contenir AUCUNE trace du type de la prochaine meteo (global.nextWeatherType) avant achat");
});

test("GET /activity/me -- forecast DEJA achete (player.weatherForecast peuple) -> weather.forecast expose EXACTEMENT ce type, weather.forecastPurchased est true", async () => {
  const global = buildGlobalState();
  const player = buildPlayerState({ weatherForecast: "rain" });
  const store = buildFakeStore({ player, global });
  const deps = buildDeps({ getFarmStore: mock.fn(async () => store) });
  const req = buildFakeReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleGetActivityMe(req as never, res as never, deps);

  const [payload] = res.json.mock.calls[0]!.arguments as [{ weather: { forecast: { key: WeatherKey; label: string; emoji: string; multiplier: number } | null; forecastPurchased: boolean } }];
  assert.deepEqual(payload.weather.forecast, { key: "rain", ...WEATHER_INFO.rain });
  assert.equal(payload.weather.forecastPurchased, true);
});

// ===========================================================================
// LOT ACTIVITY-UX-WEATHER -- POST /activity/forecast : la prevision achetee
// est immediatement revelee dans la reponse ET reste cohérente au refresh
// ===========================================================================

test("POST /activity/forecast -- TEST 5 : apres achat reussi, la reponse expose immediatement weather.forecast (plus de bouton d'achat qui ne revele rien)", async () => {
  const forecastPlayer = buildPlayerState({ coins: 150, weatherForecast: "pests" });
  const deps = buildForecastDeps({
    shouldUsePostgresRuntime: mock.fn(() => true),
    ensurePlayerExists: mock.fn(async (_playerId: string) => ({ player: forecastPlayer, created: false })) as unknown as ActivityForecastDeps["ensurePlayerExists"],
    buyPlayerWeatherForecast: mock.fn(async (_playerId: string) => "pests") as unknown as ActivityForecastDeps["buyPlayerWeatherForecast"],
    getPlayer: mock.fn(async (_playerId: string) => forecastPlayer) as unknown as ActivityForecastDeps["getPlayer"],
  });
  const req = buildFakeForecastReq("Bearer real-discord-token");
  const res = buildFakeRes();

  await handleActivityForecast(req as never, res as never, deps);

  const [payload] = res.json.mock.calls[0]!.arguments as [{ weather: { forecast: { key: WeatherKey } | null; forecastPurchased: boolean } }];
  assert.deepEqual(payload.weather.forecast, { key: "pests", ...WEATHER_INFO.pests });
  assert.equal(payload.weather.forecastPurchased, true);
});

test("POST /activity/forecast puis GET /activity/me -- TEST 6 : le forecast achete reste expose de facon identique au refresh (pas de re-verrouillage incorrect)", async () => {
  const pgPlayerState = buildPlayerState({ coins: 200, weatherForecast: null });
  const pgGlobal = buildGlobalState({ nextWeatherType: "rain" });
  const sharedGetPlayer = mock.fn(async (_playerId: string) => pgPlayerState) as unknown as ActivityForecastDeps["getPlayer"] & ActivityMeDeps["getPlayer"];
  const sharedGetGlobalState = mock.fn(async () => pgGlobal) as unknown as ActivityForecastDeps["getGlobalState"] & ActivityMeDeps["getGlobalState"];
  const buyPlayerWeatherForecast = mock.fn(async (_playerId: string) => {
    pgPlayerState.coins -= 15;
    pgPlayerState.weatherForecast = pgGlobal.nextWeatherType;
    return pgGlobal.nextWeatherType;
  }) as unknown as ActivityForecastDeps["buyPlayerWeatherForecast"];
  const shouldUsePostgresRuntime = mock.fn(() => true);
  const ensurePlayerExists = mock.fn(async () => ({ player: pgPlayerState, created: false })) as unknown as ActivityForecastDeps["ensurePlayerExists"];

  const forecastResult = await resolveActivityForecast(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, buyPlayerWeatherForecast, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  // Simule le refresh automatique (12s) de l'Activity : un second appel
  // GET /activity/me, independant du precedent, sur le MEME etat Postgres.
  const meAfterRefresh = await resolveActivityMe(
    { id: TEST_PLAYER_ID, username: "tester" },
    buildFakeStore(),
    { requireDiscordUser: mock.fn(), getFarmStore: mock.fn(), shouldUsePostgresRuntime, ensurePlayerExists, getPlayer: sharedGetPlayer, getGlobalState: sharedGetGlobalState },
  );

  assert.deepEqual(meAfterRefresh.weather.forecast, forecastResult.weather.forecast, "le refresh ne doit JAMAIS re-verrouiller un forecast deja achete");
  assert.equal(meAfterRefresh.weather.forecastPurchased, true);
  assert.deepEqual(meAfterRefresh.weather.forecast, { key: "rain", ...WEATHER_INFO.rain });
});

// ===========================================================================
// LOT ACTIVITY-UX-WEATHER -- GET /activity/crops : catalogue meteo statique
// ===========================================================================

test("buildActivityCropsPayload -- weatherTypes derive EXACTEMENT de WEATHER_INFO (aucune valeur dupliquee/inventee)", () => {
  const payload = buildActivityCropsPayload();

  assert.equal(payload.weatherTypes.length, Object.keys(WEATHER_INFO).length);
  for (const key of Object.keys(WEATHER_INFO) as WeatherKey[]) {
    const entry = payload.weatherTypes.find((w) => w.key === key);
    assert.ok(entry, `weatherTypes doit contenir l'entree "${key}"`);
    assert.deepEqual(entry, { key, ...WEATHER_INFO[key] });
  }
});
