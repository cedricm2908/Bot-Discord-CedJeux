// Tests de routes/activity.ts -- LOT A (GET /activity/me UNIQUEMENT,
// lecture seule cote Postgres). Aucune connexion Neon/Railway, aucune
// vraie requete vers discord.com : requireDiscordUser/getFarmStore/
// shouldUsePostgresRuntime/ensurePlayerExists/getPlayer/getGlobalState
// sont tous injectes via ActivityMeDeps (meme convention deps que
// farmPlayerActions.test.ts/presenters.test.ts). Les 10 autres routes
// Activity (plant/harvest/sell/buy/craft/daily/quest-claim/skin/forecast/
// autoreplant) restent hors scope de ce LOT -- non testees ici, non
// modifiees dans activity.ts.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  handleGetActivityMe,
  resolveActivityMe,
  type ActivityMeDeps,
  type DiscordUser,
} from "./activity.ts";
import type { FarmStore } from "../discord/store";
import type { GlobalState, PlayerState } from "../discord/types";

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
