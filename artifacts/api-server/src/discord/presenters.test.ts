// Tests de presenters.ts -- LOT 6, UNIQUEMENT le branchement PostgreSQL de
// /buy (resolveBuyUpgrade). N'importe jamais discord.js comme valeur
// d'execution et ne construit aucune fausse ChatInputCommandInteraction :
// resolveBuyUpgrade() a ete extrait de commandBuy() precisement pour
// rester testable ainsi -- seule la DECISION (V1 vs Postgres, quel
// resultat) est exercee ici. Le parsing des options et la construction de
// l'embed Discord restent dans commandBuy(), inchanges, non couverts par
// ce fichier (aucune regle metier n'y est ajoutee ni testee a nouveau).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import { FarmError } from "./farm.ts";
import { resolveBuyUpgrade, type BuyResolutionDeps } from "./presenters.ts";
import { POSTGRES_TEST_PLAYER_IDS_ENV_VAR, shouldUsePostgresRuntime } from "./postgresRuntimeAllowlist.ts";
import { FarmStore } from "./store.ts";
import type { PlayerState } from "./types";

const TEST_PLAYER_ID = "v2-test-player-001";

function buildPlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    userId: TEST_PLAYER_ID,
    coins: 1000,
    level: 1,
    xp: 0,
    plots: [],
    inventory: {},
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: 1000,
    createdAt: 0,
    updatedAt: 0,
    totalHarvested: 0,
    quests: [],
    questsResetAt: 0,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: null,
    ...overrides,
  };
}

// Cast minimal volontaire (meme convention que FAKE_TX ailleurs dans ce
// depot) : seul mutatePlayer() est jamais appele par resolveBuyUpgrade().
function buildFakeStore(mutatePlayer: FarmStore["mutatePlayer"]): FarmStore {
  return { mutatePlayer } as unknown as FarmStore;
}

function buildDeps(overrides: Partial<BuyResolutionDeps> = {}): BuyResolutionDeps {
  return {
    shouldUsePostgresRuntime: () => false,
    ensurePlayerExists: async (playerId: string) => ({ player: buildPlayerState({ userId: playerId }), created: false }),
    buyPlayerUpgrade: async () => ({ bought: 1, spent: 200 }),
    ...overrides,
  };
}

test("resolveBuyUpgrade A. joueur non allowliste : utilise store.mutatePlayer, jamais ensurePlayerExists/buyPlayerUpgrade, meme regle V1 (cout reel de buyUpgrade)", async () => {
  const player = buildPlayerState();
  const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
    mutator(player);
    return player;
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
  const buyPlayerUpgrade = mock.fn(async () => ({ bought: 99, spent: 99 }));
  const deps = buildDeps({ shouldUsePostgresRuntime: () => false, ensurePlayerExists, buyPlayerUpgrade });

  const result = await resolveBuyUpgrade(TEST_PLAYER_ID, "irrigation", 1, store, deps);

  assert.equal(mutatePlayer.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls.length, 0);
  assert.equal(buyPlayerUpgrade.mock.calls.length, 0);
  // buyUpgrade("irrigation", niveau 0) reel de farm.ts : cout Math.round(200*1.45^0)=200 -- regle V1 inchangee.
  assert.deepEqual(result, { bought: 1, spent: 200 });
  assert.equal(player.irrigationLevel, 1);
  assert.equal(player.coins, 800);
});

test("resolveBuyUpgrade B. joueur allowliste existant : ensurePlayerExists + buyPlayerUpgrade avec le bon playerId/kind/quantite, jamais store.mutatePlayer", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("store.mutatePlayer ne doit jamais etre appele sur le chemin Postgres");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const buyPlayerUpgrade = mock.fn(async () => ({ bought: 3, spent: 450 }));
  const deps = buildDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, buyPlayerUpgrade });

  const result = await resolveBuyUpgrade(TEST_PLAYER_ID, "plots", 3, store, deps);

  assert.equal(ensurePlayerExists.mock.calls.length, 1);
  assert.equal(ensurePlayerExists.mock.calls[0]!.arguments[0], TEST_PLAYER_ID);
  assert.equal(buyPlayerUpgrade.mock.calls.length, 1);
  assert.deepEqual(buyPlayerUpgrade.mock.calls[0]!.arguments, [TEST_PLAYER_ID, "plots", 3]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
  assert.deepEqual(result, { bought: 3, spent: 450 });
});

test("resolveBuyUpgrade C. joueur allowliste absent : bootstrap (created=true) PUIS buyPlayerUpgrade, aucun chemin JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun chemin JSON attendu pour un joueur allowliste");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const callOrder: string[] = [];
  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    callOrder.push("ensure");
    return { player: buildPlayerState({ userId: playerId }), created: true };
  });
  const buyPlayerUpgrade = mock.fn(async () => {
    callOrder.push("buy");
    return { bought: 1, spent: 200 };
  });
  const deps = buildDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, buyPlayerUpgrade });

  await resolveBuyUpgrade(TEST_PLAYER_ID, "irrigation", 1, store, deps);

  assert.deepEqual(callOrder, ["ensure", "buy"]);
  assert.equal(mutatePlayer.mock.calls.length, 0);
});

test("resolveBuyUpgrade D. erreur metier Postgres : FarmError propagee telle quelle, aucun fallback silencieux vers JSON", async () => {
  const mutatePlayer = mock.fn(async () => {
    throw new Error("aucun fallback JSON attendu apres une erreur Postgres");
  });
  const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
  const ensurePlayerExists = mock.fn(async (playerId: string) => ({
    player: buildPlayerState({ userId: playerId }),
    created: false,
  }));
  const buyPlayerUpgrade = mock.fn(async () => {
    throw new FarmError("Achat impossible : niveau maximum atteint ou pièces insuffisantes.");
  });
  const deps = buildDeps({ shouldUsePostgresRuntime: () => true, ensurePlayerExists, buyPlayerUpgrade });

  await assert.rejects(
    () => resolveBuyUpgrade(TEST_PLAYER_ID, "irrigation", 1, store, deps),
    (error: unknown) => error instanceof FarmError,
  );
  assert.equal(mutatePlayer.mock.calls.length, 0, "aucun fallback silencieux vers JSON apres une erreur Postgres");
});

test("resolveBuyUpgrade E. env FARM2WIN_POSTGRES_TEST_PLAYER_IDS absente, avec la VRAIE shouldUsePostgresRuntime (non mockee) : comportement V1 par defaut", async () => {
  const originalEnv = process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
  try {
    delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    const player = buildPlayerState();
    const mutatePlayer = mock.fn(async (_playerId: string, mutator: (p: PlayerState) => void) => {
      mutator(player);
      return player;
    });
    const store = buildFakeStore(mutatePlayer as unknown as FarmStore["mutatePlayer"]);
    const ensurePlayerExists = mock.fn(async () => ({ player, created: false }));
    const buyPlayerUpgrade = mock.fn(async () => ({ bought: 999, spent: 999 }));

    const result = await resolveBuyUpgrade(TEST_PLAYER_ID, "irrigation", 1, store, {
      shouldUsePostgresRuntime, // la VRAIE fonction importee, pas un mock
      ensurePlayerExists,
      buyPlayerUpgrade,
    });

    assert.equal(mutatePlayer.mock.calls.length, 1);
    assert.equal(ensurePlayerExists.mock.calls.length, 0);
    assert.equal(buyPlayerUpgrade.mock.calls.length, 0);
    assert.equal(result.spent, 200);
  } finally {
    if (originalEnv === undefined) delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    else process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR] = originalEnv;
  }
});

// ===========================================================================
// Audit anti-divergence (LOT 6) : shouldUsePostgresRuntime/ensurePlayerExists/
// buyPlayerUpgrade ne doivent avoir QU'UN SEUL site d'appel chacun dans tout
// presenters.ts -- celui de resolveBuyUpgrade. Preuve automatisee (lecture
// du fichier source, meme technique que les tests transversaux existants
// de farmRepository.test.ts/farmPlayerActions.test.ts) qu'aucune autre
// commande (/plant, /craft, /daily, /farm, etc.) n'a ete branchee sur
// Postgres par erreur.
// ===========================================================================

test("presenters.ts : shouldUsePostgresRuntime/ensurePlayerExists/buyPlayerUpgrade ne sont appeles qu'une seule fois (dans resolveBuyUpgrade), aucune autre commande", async () => {
  const source = await readFile(new URL("./presenters.ts", import.meta.url), "utf8");
  const countCalls = (name: string) => (source.match(new RegExp(`${name}\\(`, "g")) ?? []).length;

  assert.equal(countCalls("shouldUsePostgresRuntime"), 1, "un seul site d'appel attendu (resolveBuyUpgrade)");
  assert.equal(countCalls("ensurePlayerExists"), 1, "un seul site d'appel attendu (resolveBuyUpgrade)");
  assert.equal(countCalls("buyPlayerUpgrade"), 1, "un seul site d'appel attendu (resolveBuyUpgrade)");
});
