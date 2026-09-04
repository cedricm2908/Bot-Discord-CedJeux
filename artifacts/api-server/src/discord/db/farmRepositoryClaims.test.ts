// Tests des primitives d'ELECTION ATOMIQUE + FAN-OUT du LOT 5
// (claimAndMutatePlayer, tryClaimWeeklyReset, getWeeklyRewardAssignments,
// tryClaimDailyChallengeReward, claimReadyPlotNotification), dans un
// fichier separe de farmRepository.test.ts pour rester lisible (sous-
// systeme distinct). Aucune connexion PostgreSQL : uniquement des DTO
// construits en memoire et des dependances mockees, meme convention que
// le reste du fichier source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import type {
  DailyChallengeContributor,
  DailyChallengeRow,
  InventoryItem as InventoryItemRow,
  Player,
  Plot as PlotRow,
  RewardClaim,
} from "@workspace/db";
import type { PlayerRecord } from "@workspace/db/repositories";
import {
  claimAndMutatePlayer,
  claimReadyPlotNotification,
  dailyChallengeRewardClaimType,
  getCurrentWeeklyCycleId,
  getPendingWeeklyCycleIds,
  getUnrewardedCompletedDailyChallenges,
  getWeeklyCycleMembers,
  getWeeklyRewardAssignments,
  getWeeklySnapshotTargets,
  resumeDailyChallengeReward,
  resumeWeeklyRewards,
  tryClaimWeeklyReset,
  weeklyBonusAssignmentClaimType,
  weeklyBonusPayoutClaimType,
  weeklyMemberClaimType,
  weeklySnapshotClaimType,
  weeklySnapshotTargetClaimType,
  type ClaimAndMutatePlayerDeps,
  type ClaimReadyPlotNotificationDeps,
  type DailyChallengeResumeDeps,
  type GetUnrewardedCompletedDailyChallengesDeps,
  type GetWeeklyCycleMembersDeps,
  type WeeklyRewardClaimDeps,
  type WeeklyResumeDeps,
  type WeeklySnapshotTarget,
} from "./farmRepository.ts";
import { toPlayerState } from "./playerAdapter.ts";
import type { PlayerState } from "../types";

const NOW = new Date(1_700_000_000_000);
const TEST_PLAYER_ID = "v2-test-player-001";
const FAKE_TX = { marker: "fake-tx" } as never;

function buildPlayerRow(id: string, overrides: Partial<Player> = {}): Player {
  return {
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
    ...overrides,
  } as Player;
}

function buildDailyChallengeRow(overrides: Partial<DailyChallengeRow> = {}): DailyChallengeRow {
  return {
    id: 1,
    cropId: "wheat",
    target: 200,
    progress: 200,
    rewardCoins: 80,
    startedAt: NOW,
    completed: true,
    rewarded: false,
    ...overrides,
  } as DailyChallengeRow;
}

async function runTx<T>(fn: (tx: never) => Promise<T>): Promise<T> {
  return fn(FAKE_TX);
}

// ===========================================================================
// claimAndMutatePlayer
// ===========================================================================

function buildClaimAndMutatePlayerDeps(overrides: Partial<ClaimAndMutatePlayerDeps> = {}): ClaimAndMutatePlayerDeps {
  return {
    lockAndGetPlayer: async (_tx, id) => buildPlayerRow(id),
    updatePlayerRow: async () => {},
    upsertPlots: async () => {},
    upsertInventoryItems: async () => {},
    getPlotsForUpdate: async () => [],
    getInventoryItemsForUpdate: async () => [],
    toPlayerState,
    tryInsertRewardClaim: async () => true,
    ...overrides,
  };
}

test("claimAndMutatePlayer 1. reclamation reussie : claim insere, mutator applique, joueur retourne", async () => {
  const tryInsertRewardClaim = mock.fn(async (..._args: Parameters<ClaimAndMutatePlayerDeps["tryInsertRewardClaim"]>) => true);
  const deps = buildClaimAndMutatePlayerDeps({ tryInsertRewardClaim });

  const result = await claimAndMutatePlayer(
    TEST_PLAYER_ID,
    "daily-challenge-reward:1",
    (player) => {
      player.coins += 80;
    },
    deps,
    runTx,
  );

  assert.equal(result.claimed, true);
  assert.equal(result.player?.coins, 130);
  assert.equal(tryInsertRewardClaim.mock.calls.length, 1);
  assert.deepEqual(tryInsertRewardClaim.mock.calls[0]!.arguments.slice(1), [TEST_PLAYER_ID, "daily-challenge-reward:1"]);
});

test("claimAndMutatePlayer 2. deja reclame : aucune lecture plots/inventory, mutator jamais appele, aucune ecriture, idempotent", async () => {
  const mutator = mock.fn((_player: PlayerState) => {});
  const getPlotsForUpdate = mock.fn(async (..._args: Parameters<ClaimAndMutatePlayerDeps["getPlotsForUpdate"]>) => []);
  const updatePlayerRow = mock.fn(async (..._args: Parameters<ClaimAndMutatePlayerDeps["updatePlayerRow"]>) => {});
  const deps = buildClaimAndMutatePlayerDeps({
    tryInsertRewardClaim: async () => false,
    getPlotsForUpdate,
    updatePlayerRow,
  });

  const result = await claimAndMutatePlayer(TEST_PLAYER_ID, "daily-challenge-reward:1", mutator, deps, runTx);

  assert.equal(result.claimed, false);
  assert.equal(result.player, null);
  assert.equal(mutator.mock.calls.length, 0);
  assert.equal(getPlotsForUpdate.mock.calls.length, 0);
  assert.equal(updatePlayerRow.mock.calls.length, 0);
});

test("claimAndMutatePlayer 3. joueur absent : rejette, tryInsertRewardClaim jamais appele", async () => {
  const tryInsertRewardClaim = mock.fn(async (..._args: Parameters<ClaimAndMutatePlayerDeps["tryInsertRewardClaim"]>) => true);
  const deps = buildClaimAndMutatePlayerDeps({ lockAndGetPlayer: async () => null, tryInsertRewardClaim });

  await assert.rejects(
    () => claimAndMutatePlayer(TEST_PLAYER_ID, "daily-challenge-reward:1", () => {}, deps, runTx),
    /introuvable/,
  );
  assert.equal(tryInsertRewardClaim.mock.calls.length, 0);
});

test("claimAndMutatePlayer 4. mutator qui leve : rejette, aucune ecriture (le claim entre dans le meme rollback)", async () => {
  const updatePlayerRow = mock.fn(async (..._args: Parameters<ClaimAndMutatePlayerDeps["updatePlayerRow"]>) => {});
  const deps = buildClaimAndMutatePlayerDeps({ updatePlayerRow });

  await assert.rejects(
    () =>
      claimAndMutatePlayer(
        TEST_PLAYER_ID,
        "daily-challenge-reward:1",
        () => {
          throw new Error("echec metier simule");
        },
        deps,
        runTx,
      ),
    /echec metier simule/,
  );
  assert.equal(updatePlayerRow.mock.calls.length, 0);
});

test("claimAndMutatePlayer 5. ordre strict : lock -> claim -> plots -> inventory -> adapter -> mutator -> ecriture", async () => {
  const callOrder: string[] = [];
  const deps = buildClaimAndMutatePlayerDeps({
    lockAndGetPlayer: async (_tx, id) => {
      callOrder.push("lock");
      return buildPlayerRow(id);
    },
    tryInsertRewardClaim: async () => {
      callOrder.push("claim");
      return true;
    },
    getPlotsForUpdate: async () => {
      callOrder.push("plots");
      return [];
    },
    getInventoryItemsForUpdate: async () => {
      callOrder.push("inventory");
      return [];
    },
    toPlayerState: (r: PlayerRecord) => {
      callOrder.push("adapter");
      return toPlayerState(r);
    },
    updatePlayerRow: async () => {
      callOrder.push("write");
    },
  });

  await claimAndMutatePlayer(
    TEST_PLAYER_ID,
    "daily-challenge-reward:1",
    () => {
      callOrder.push("mutator");
    },
    deps,
    runTx,
  );

  assert.deepEqual(callOrder, ["lock", "claim", "plots", "inventory", "adapter", "mutator", "write"]);
});

test("claimAndMutatePlayer 6. createdAt inchange, updatedAt coherent", async () => {
  const updatePlayerRow = mock.fn(async (..._args: Parameters<ClaimAndMutatePlayerDeps["updatePlayerRow"]>) => {});
  const deps = buildClaimAndMutatePlayerDeps({ updatePlayerRow });

  const result = await claimAndMutatePlayer(
    TEST_PLAYER_ID,
    "daily-challenge-reward:1",
    (player) => {
      player.coins += 1;
    },
    deps,
    runTx,
  );

  const [, , values] = updatePlayerRow.mock.calls[0]!.arguments;
  assert.ok(!("createdAt" in values));
  assert.ok(values.updatedAt instanceof Date);
  assert.equal(result.player?.createdAt, NOW.getTime());
  assert.equal(result.player?.updatedAt, values.updatedAt.getTime());
});

test("claimAndMutatePlayer 7. ouvre une seule transaction", async () => {
  let transactionCalls = 0;
  const fakeRunTransaction = async (fn: (tx: never) => Promise<unknown>) => {
    transactionCalls += 1;
    return fn(FAKE_TX);
  };

  await claimAndMutatePlayer(
    TEST_PLAYER_ID,
    "daily-challenge-reward:1",
    (player) => {
      player.coins += 1;
    },
    buildClaimAndMutatePlayerDeps(),
    fakeRunTransaction as never,
  );

  assert.equal(transactionCalls, 1);
});

// ===========================================================================
// tryClaimWeeklyReset / getWeeklyRewardAssignments
// ===========================================================================

const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const NOT_DUE_WEEKLY_STARTED_AT = new Date(NOW.getTime() - 1000);
const DUE_WEEKLY_STARTED_AT = new Date(NOW.getTime() - WEEKLY_INTERVAL_MS - 1000);

function buildWeeklyDeps(overrides: Partial<WeeklyRewardClaimDeps> = {}): WeeklyRewardClaimDeps {
  return {
    peekWeeklyStartedAt: async () => DUE_WEEKLY_STARTED_AT,
    getAllPlayersForWeeklyRanking: async () => [
      { id: "p1", coins: 500, weeklySnapshotCoins: 100 }, // delta 400
      { id: "p2", coins: 300, weeklySnapshotCoins: 100 }, // delta 200
      { id: "p3", coins: 250, weeklySnapshotCoins: 100 }, // delta 150
      { id: "p4", coins: 150, weeklySnapshotCoins: 100 }, // delta 50
    ],
    tryAdvanceWeeklyStartedAt: async () => true,
    tryInsertRewardClaim: async () => true,
    ...overrides,
  };
}

test("tryClaimWeeklyReset 1. cycle non du : claimed=false, aucune lecture des joueurs, aucune ecriture", async () => {
  const getAllPlayersForWeeklyRanking = mock.fn(
    async (..._args: Parameters<WeeklyRewardClaimDeps["getAllPlayersForWeeklyRanking"]>) => [],
  );
  const tryAdvanceWeeklyStartedAt = mock.fn(
    async (..._args: Parameters<WeeklyRewardClaimDeps["tryAdvanceWeeklyStartedAt"]>) => true,
  );
  const deps = buildWeeklyDeps({
    peekWeeklyStartedAt: async () => NOT_DUE_WEEKLY_STARTED_AT,
    getAllPlayersForWeeklyRanking,
    tryAdvanceWeeklyStartedAt,
  });

  const result = await tryClaimWeeklyReset(deps, runTx, NOW);

  assert.equal(result.claimed, false);
  assert.equal(getAllPlayersForWeeklyRanking.mock.calls.length, 0);
  assert.equal(tryAdvanceWeeklyStartedAt.mock.calls.length, 0);
});

test("tryClaimWeeklyReset 2. cycle du, election gagnee : classement correct (delta decroissant), montants 500/300/150, cycleId, POPULATION COMPLETE et assignations inserees", async () => {
  const tryInsertRewardClaim = mock.fn(
    async (..._args: Parameters<WeeklyRewardClaimDeps["tryInsertRewardClaim"]>) => true,
  );
  const deps = buildWeeklyDeps({ tryInsertRewardClaim });
  const cycleId = String(DUE_WEEKLY_STARTED_AT.getTime());

  const result = await tryClaimWeeklyReset(deps, runTx, NOW);

  assert.equal(result.claimed, true);
  if (!result.claimed) throw new Error("unreachable");
  assert.equal(result.cycleId, cycleId);
  assert.deepEqual(result.winners, [
    { playerId: "p1", rank: 1, bonus: 500 },
    { playerId: "p2", rank: 2, bonus: 300 },
    { playerId: "p3", rank: 3, bonus: 150 },
  ]);
  assert.deepEqual(result.allPlayerIds, ["p1", "p2", "p3", "p4"]);
  // 4 membres + 4 cibles de snapshot (TOUTE la population) + 3 assignations (gagnants uniquement).
  assert.equal(tryInsertRewardClaim.mock.calls.length, 11);
  const insertedArgs = tryInsertRewardClaim.mock.calls.map((call) => call.arguments.slice(1));
  for (const playerId of ["p1", "p2", "p3", "p4"]) {
    assert.ok(
      insertedArgs.some((args) => args[0] === playerId && args[1] === weeklyMemberClaimType(cycleId)),
      `membre ${playerId} doit avoir une ligne weekly-member`,
    );
  }
  assert.ok(insertedArgs.some((args) => args[0] === "p1" && args[1] === weeklyBonusAssignmentClaimType(cycleId, 1)));
  assert.ok(insertedArgs.some((args) => args[0] === "p2" && args[1] === weeklyBonusAssignmentClaimType(cycleId, 2)));
  assert.ok(insertedArgs.some((args) => args[0] === "p3" && args[1] === weeklyBonusAssignmentClaimType(cycleId, 3)));
  // Cibles de snapshot : coins observes A L'ELECTION + bonus pour les gagnants,
  // rien de plus pour p4 (non-gagnant).
  assert.ok(insertedArgs.some((args) => args[0] === "p1" && args[1] === weeklySnapshotTargetClaimType(cycleId, 1000))); // 500 + 500
  assert.ok(insertedArgs.some((args) => args[0] === "p2" && args[1] === weeklySnapshotTargetClaimType(cycleId, 600))); // 300 + 300
  assert.ok(insertedArgs.some((args) => args[0] === "p3" && args[1] === weeklySnapshotTargetClaimType(cycleId, 400))); // 250 + 150
  assert.ok(insertedArgs.some((args) => args[0] === "p4" && args[1] === weeklySnapshotTargetClaimType(cycleId, 150))); // 150, pas de bonus
});

test("tryClaimWeeklyReset 3. cycle du mais course perdue (CAS echoue) : claimed=false, aucune assignation inseree", async () => {
  const tryInsertRewardClaim = mock.fn(
    async (..._args: Parameters<WeeklyRewardClaimDeps["tryInsertRewardClaim"]>) => true,
  );
  const deps = buildWeeklyDeps({ tryAdvanceWeeklyStartedAt: async () => false, tryInsertRewardClaim });

  const result = await tryClaimWeeklyReset(deps, runTx, NOW);

  assert.equal(result.claimed, false);
  assert.equal(tryInsertRewardClaim.mock.calls.length, 0);
});

test("tryClaimWeeklyReset 4. moins de 3 joueurs : winners = nombre de joueurs disponibles, pas de bonus fantome", async () => {
  const deps = buildWeeklyDeps({
    getAllPlayersForWeeklyRanking: async () => [{ id: "solo", coins: 200, weeklySnapshotCoins: 100 }],
  });

  const result = await tryClaimWeeklyReset(deps, runTx, NOW);

  assert.equal(result.claimed, true);
  if (!result.claimed) throw new Error("unreachable");
  assert.deepEqual(result.winners, [{ playerId: "solo", rank: 1, bonus: 500 }]);
  assert.deepEqual(result.allPlayerIds, ["solo"]);
});

test("tryClaimWeeklyReset 5. global_state absent : rejette", async () => {
  const deps = buildWeeklyDeps({ peekWeeklyStartedAt: async () => null });

  await assert.rejects(() => tryClaimWeeklyReset(deps, runTx, NOW), /introuvable/);
});

test("tryClaimWeeklyReset 13. deux elections concurrentes : un seul plan complet cree (population + assignations)", async () => {
  let advanced = false;
  const sharedTryAdvance = async () => {
    if (advanced) return false;
    advanced = true;
    return true;
  };
  const insertedClaims: string[] = [];
  const deps = buildWeeklyDeps({
    tryAdvanceWeeklyStartedAt: sharedTryAdvance,
    tryInsertRewardClaim: async (_tx, playerId, claimType) => {
      insertedClaims.push(`${playerId}:${claimType}`);
      return true;
    },
  });

  const [resultA, resultB] = await Promise.all([
    tryClaimWeeklyReset(deps, runTx, NOW),
    tryClaimWeeklyReset(deps, runTx, NOW),
  ]);

  const claimedCount = [resultA, resultB].filter((r) => r.claimed).length;
  assert.equal(claimedCount, 1, "exactement un des deux appels doit gagner l'election");
  assert.equal(
    insertedClaims.length,
    11,
    "le plan complet (4 membres + 4 cibles + 3 assignations) ne doit etre insere qu'une seule fois, par le seul gagnant",
  );
});

test("tryClaimWeeklyReset 7. cycle suivant peut etre reclame normalement (nouveau cycleId, nouvelle election possible)", async () => {
  const secondCycleWeeklyStartedAt = new Date(NOW.getTime() - WEEKLY_INTERVAL_MS - 1000);
  const laterNow = new Date(NOW.getTime() + WEEKLY_INTERVAL_MS + 2000);
  const deps = buildWeeklyDeps({ peekWeeklyStartedAt: async () => secondCycleWeeklyStartedAt });

  const result = await tryClaimWeeklyReset(deps, runTx, laterNow);

  assert.equal(result.claimed, true);
  if (!result.claimed) throw new Error("unreachable");
  assert.equal(result.cycleId, String(secondCycleWeeklyStartedAt.getTime()));
});

test("getWeeklyRewardAssignments : reconstruit les gagnants a partir des lignes reward_claims (reprise apres redemarrage)", async () => {
  const cycleId = "1699000000000";
  const rows: RewardClaim[] = [
    { id: 1, playerId: "p3", claimType: weeklyBonusAssignmentClaimType(cycleId, 3), claimedAt: NOW },
    { id: 2, playerId: "p1", claimType: weeklyBonusAssignmentClaimType(cycleId, 1), claimedAt: NOW },
    { id: 3, playerId: "p2", claimType: weeklyBonusAssignmentClaimType(cycleId, 2), claimedAt: NOW },
    // Ligne d'un AUTRE cycle -- ne doit jamais etre incluse.
    { id: 4, playerId: "px", claimType: weeklyBonusAssignmentClaimType("autre-cycle", 1), claimedAt: NOW },
  ] as RewardClaim[];
  const listRewardClaimsByPrefix = mock.fn(async (_prefix: string) => rows.filter((r) => r.claimType.startsWith(`weekly-bonus-assignment:${cycleId}:rank`)));

  const winners = await getWeeklyRewardAssignments(cycleId, { listRewardClaimsByPrefix });

  assert.deepEqual(winners, [
    { playerId: "p1", rank: 1, bonus: 500 },
    { playerId: "p2", rank: 2, bonus: 300 },
    { playerId: "p3", rank: 3, bonus: 150 },
  ]);
});

// ===========================================================================
// COHERENCE D'IDENTITE DU CYCLE (correction) : le cycleId sous lequel
// tryClaimWeeklyReset() persiste le plan (ancien weeklyStartedAt, avant le
// CAS) NE DOIT JAMAIS etre confondu avec getCurrentWeeklyCycleId() (qui
// reflete la valeur APRES le CAS, donc le cycle SUIVANT, pas encore du).
// ===========================================================================

test("Coherence d'identite 1. le cycleId retourne par tryClaimWeeklyReset differe de getCurrentWeeklyCycleId juste apres l'election", async () => {
  const oldWeeklyStartedAt = DUE_WEEKLY_STARTED_AT; // "A"
  let storedWeeklyStartedAt = oldWeeklyStartedAt;
  const deps = buildWeeklyDeps({
    peekWeeklyStartedAt: async () => storedWeeklyStartedAt,
    tryAdvanceWeeklyStartedAt: async (_tx, expectedOldValue, newValue) => {
      if (expectedOldValue.getTime() !== storedWeeklyStartedAt.getTime()) return false;
      storedWeeklyStartedAt = newValue; // simule le CAS reel : weekly_started_at devient "B"
      return true;
    },
  });

  const result = await tryClaimWeeklyReset(deps, runTx, NOW);
  assert.equal(result.claimed, true);
  if (!result.claimed) throw new Error("unreachable");

  const cycleIdAfterElection = await getCurrentWeeklyCycleId({
    getGlobalState: async () => ({ weeklyStartedAt: storedWeeklyStartedAt.getTime() }) as never,
  });

  assert.equal(result.cycleId, String(oldWeeklyStartedAt.getTime()), "le plan doit etre sous l'ANCIEN weeklyStartedAt (A)");
  assert.notEqual(
    cycleIdAfterElection,
    result.cycleId,
    "getCurrentWeeklyCycleId() apres l'election reflete le cycle SUIVANT (B), jamais celui qui vient d'etre elu (A) -- confirme que getCurrentWeeklyCycleId ne doit PAS servir a decouvrir un cycle a reprendre",
  );
});

// ===========================================================================
// resumeWeeklyRewards / getWeeklyCycleMembers / getPendingWeeklyCycleIds --
// fan-out DURABLE, population FIGEE, decouverte multi-cycles (correction :
// le fan-out complet -- bonus PUIS snapshot pour chaque MEMBRE FIGE du
// cycle -- doit etre entierement rejouable depuis PostgreSQL apres un
// redemarrage complet, et plusieurs cycles incomplets doivent tous rester
// decouvrables independamment de global_state.weekly_started_at).
// ===========================================================================

const CYCLE_ID = "1699000000000";

interface FakePlayerFixture {
  userId: string;
  coins: number;
  weeklySnapshotCoins: number;
}

// Simule fidelement la semantique reelle de claimAndMutatePlayer (verrou +
// claim + mutation atomiques ensemble) avec un etat partage en memoire :
// un meme (playerId, claimType) ne peut jamais declencher le mutator une
// seconde fois -- exactement la garantie que la vraie contrainte UNIQUE de
// reward_claims fournit cote Postgres.
function buildFakeClaimAndMutatePlayer(
  players: Map<string, FakePlayerFixture>,
  preClaimedKeys: Iterable<string> = [],
) {
  const claimedKeys = new Set<string>(preClaimedKeys);
  const callOrder: string[] = [];
  const fn = async (
    playerId: string,
    claimType: string,
    mutator: (player: FakePlayerFixture) => void | Promise<void>,
  ) => {
    const key = `${playerId}:${claimType}`;
    callOrder.push(key);
    if (claimedKeys.has(key)) {
      return { claimed: false, player: null };
    }
    claimedKeys.add(key);
    const player = players.get(playerId);
    if (!player) throw new Error(`joueur inconnu dans la fixture : ${playerId}`);
    await mutator(player);
    return { claimed: true, player: { ...player } };
  };
  return { fn: fn as unknown as WeeklyResumeDeps["claimAndMutatePlayer"], claimedKeys, callOrder, players };
}

// `targets` : cible de weeklySnapshotCoins FIGEE A L'ELECTION pour chaque
// membre (playerId -> valeur), OBLIGATOIRE et INDEPENDANTE de la valeur
// courante de `players` -- exactement ce qui permet a un test de simuler
// du gameplay survenu ENTRE l'election et resumeWeeklyRewards() sans que
// ce gameplay ne contamine le snapshot (voir "resumeWeeklyRewards NOUVEAU
// 1./2." plus bas, correction du bug de snapshot tardif).
function buildResumeWeeklyDeps(
  winners: { playerId: string; rank: number; bonus: number }[],
  players: Map<string, FakePlayerFixture>,
  preClaimedKeys: Iterable<string> = [],
  targets: Record<string, number> = {},
): { deps: WeeklyResumeDeps; fake: ReturnType<typeof buildFakeClaimAndMutatePlayer> } {
  const fake = buildFakeClaimAndMutatePlayer(players, preClaimedKeys);
  const deps: WeeklyResumeDeps = {
    getWeeklyRewardAssignments: async () => winners,
    // Population FIGEE (simule les lignes weekly-member deja persistees),
    // JAMAIS une lecture fraiche de tous les joueurs -- c'est precisement
    // ce qui garantit qu'un joueur cree apres l'election n'est jamais
    // inclus (voir "resumeWeeklyRewards 10.").
    getWeeklyCycleMembers: async () => [...players.keys()],
    getWeeklySnapshotTargets: async () =>
      Object.entries(targets).map(([playerId, target]) => ({ playerId, target })),
    claimAndMutatePlayer: fake.fn,
  };
  return { deps, fake };
}

test("resumeWeeklyRewards 1. gagnant : bonus PUIS snapshot, dans cet ordre", async () => {
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 500, weeklySnapshotCoins: 100 }],
  ]);
  const { deps, fake } = buildResumeWeeklyDeps([{ playerId: "p1", rank: 1, bonus: 500 }], players, [], { p1: 1000 });

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.deepEqual(fake.callOrder, [
    `p1:${weeklyBonusPayoutClaimType(CYCLE_ID)}`,
    `p1:${weeklySnapshotClaimType(CYCLE_ID)}`,
  ]);
});

test("resumeWeeklyRewards 2. bonus deja claim : pas repaye ; le snapshot applique la cible FIGEE, pas les coins courants", async () => {
  const players = new Map<string, FakePlayerFixture>([
    // coins deja incrementes par un run precedent (100 a l'election + 500
    // de bonus deja applique) -- le mutator de bonus ne doit PAS
    // s'executer une seconde fois.
    ["p1", { userId: "p1", coins: 1000, weeklySnapshotCoins: 100 }],
  ]);
  const { deps } = buildResumeWeeklyDeps(
    [{ playerId: "p1", rank: 1, bonus: 500 }],
    players,
    [`p1:${weeklyBonusPayoutClaimType(CYCLE_ID)}`],
    { p1: 1000 }, // cible figee a l'election : 100 (coinsAtElection) + 500 (bonus)
  );

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.equal(players.get("p1")!.coins, 1000, "coins ne doivent pas avoir change (bonus deja claim)");
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 1000, "le snapshot applique la cible FIGEE (1000), pas une relecture de p.coins");
});

test("resumeWeeklyRewards 3. snapshot deja claim : pas refait", async () => {
  const players = new Map<string, FakePlayerFixture>([["p2", { userId: "p2", coins: 300, weeklySnapshotCoins: 999 }]]);
  const { deps } = buildResumeWeeklyDeps([], players, [`p2:${weeklySnapshotClaimType(CYCLE_ID)}`], { p2: 300 });

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.equal(players.get("p2")!.weeklySnapshotCoins, 999, "weeklySnapshotCoins ne doit pas avoir change (deja claim)");
});

test("resumeWeeklyRewards 4. crash simule apres bonus mais avant snapshot : reprise correcte, cible figee appliquee", async () => {
  // Premiere "execution" : seul le bonus a ete applique et claim (coins
  // deja incrementes en base), le snapshot n'a JAMAIS ete tente.
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 600, weeklySnapshotCoins: 100 }], // 100 + 500 de bonus deja applique
  ]);
  const { deps } = buildResumeWeeklyDeps(
    [{ playerId: "p1", rank: 1, bonus: 500 }],
    players,
    [`p1:${weeklyBonusPayoutClaimType(CYCLE_ID)}`],
    { p1: 600 }, // cible figee a l'election : 100 (coinsAtElection) + 500 (bonus)
  );

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.equal(players.get("p1")!.coins, 600, "coins inchanges (bonus deja fait)");
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 600, "snapshot desormais fait, egal a la cible figee");
});

test("resumeWeeklyRewards 5. crash simule apres traitement d'une partie des joueurs : reprise correcte pour les seuls manquants", async () => {
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 600, weeklySnapshotCoins: 600 }], // deja entierement traite
    ["p2", { userId: "p2", coins: 300, weeklySnapshotCoins: 100 }], // jamais traite
  ]);
  const { deps, fake } = buildResumeWeeklyDeps(
    [{ playerId: "p1", rank: 1, bonus: 500 }],
    players,
    [`p1:${weeklyBonusPayoutClaimType(CYCLE_ID)}`, `p1:${weeklySnapshotClaimType(CYCLE_ID)}`],
    { p1: 600, p2: 300 },
  );

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.equal(players.get("p1")!.coins, 600, "joueur deja traite : inchange");
  assert.equal(players.get("p2")!.weeklySnapshotCoins, 300, "joueur non gagnant, jamais traite : desormais synchronise sur sa cible figee");
  assert.ok(fake.claimedKeys.has(`p2:${weeklySnapshotClaimType(CYCLE_ID)}`));
});

test("resumeWeeklyRewards 6. tous les joueurs finissent avec weeklySnapshotCoins = leur cible figee (sans gameplay entre-temps, celle-ci egale coins)", async () => {
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 500, weeklySnapshotCoins: 100 }],
    ["p2", { userId: "p2", coins: 300, weeklySnapshotCoins: 100 }],
    ["p3", { userId: "p3", coins: 80, weeklySnapshotCoins: 50 }], // non gagnant
  ]);
  const winners = [
    { playerId: "p1", rank: 1, bonus: 500 },
    { playerId: "p2", rank: 2, bonus: 300 },
  ];
  const { deps } = buildResumeWeeklyDeps(winners, players, [], { p1: 1000, p2: 600, p3: 80 });

  await resumeWeeklyRewards(CYCLE_ID, deps);

  for (const player of players.values()) {
    assert.equal(player.weeklySnapshotCoins, player.coins, `${player.userId} : weeklySnapshotCoins doit egaler coins (aucune derive de gameplay dans ce scenario)`);
  }
});

test("resumeWeeklyRewards 7. le snapshot d'un gagnant inclut bien son bonus", async () => {
  const players = new Map<string, FakePlayerFixture>([["p1", { userId: "p1", coins: 200, weeklySnapshotCoins: 100 }]]);
  const { deps } = buildResumeWeeklyDeps([{ playerId: "p1", rank: 1, bonus: 500 }], players, [], { p1: 700 });

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.equal(players.get("p1")!.coins, 700); // 200 + 500
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 700, "le snapshot doit inclure le bonus, pas seulement les coins pre-bonus");
});

test("resumeWeeklyRewards 8. cycle suivant utilise des claim_type differents (pas de blocage entre cycles)", async () => {
  const players = new Map<string, FakePlayerFixture>([["p1", { userId: "p1", coins: 100, weeklySnapshotCoins: 100 }]]);
  const winners = [{ playerId: "p1", rank: 1, bonus: 500 }];
  const { deps: depsCycleA } = buildResumeWeeklyDeps(winners, players, [], { p1: 600 });
  await resumeWeeklyRewards("cycle-A", depsCycleA);
  assert.equal(players.get("p1")!.coins, 600);

  // Nouveau cycle, MEME joueur, MEME rang : le claim_type differe par
  // cycleId, donc le bonus est de nouveau applicable (pas bloque par le
  // cycle precedent). Sa cible est aussi INDEPENDANTE : calculee a partir
  // du solde reel au moment de CETTE election (600, deja gonfle par le
  // cycle A), pas rejouee depuis le cycle A.
  const { deps: depsCycleB } = buildResumeWeeklyDeps(winners, players, [], { p1: 1100 });
  await resumeWeeklyRewards("cycle-B", depsCycleB);
  assert.equal(players.get("p1")!.coins, 1100, "le bonus du cycle B doit s'appliquer independamment du cycle A");
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 1100, "la cible du cycle B est la sienne propre");
});

// ---------------------------------------------------------------------------
// CORRECTION : snapshot tardif. Le fan-out utilisait auparavant
// `p.weeklySnapshotCoins = p.coins` AU MOMENT DE LA REPRISE -- si du
// gameplay survient entre l'election et resumeWeeklyRewards() (normal en
// cas de reprise differee ou de crash), ce gameplay etait a tort inclus
// dans le snapshot de la semaine qui se termine. Desormais, la cible est
// TOUJOURS celle figee a l'election (voir weeklySnapshotTargetClaimType),
// jamais recalculee depuis les coins courants.
// ---------------------------------------------------------------------------

test("resumeWeeklyRewards NOUVEAU 1. non-gagnant : gameplay entre election et reprise n'affecte jamais le snapshot cible (coins=100 a l'election, 120 avant reprise, snapshot final=100)", async () => {
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 120, weeklySnapshotCoins: 50 }], // +20 de gameplay APRES l'election (coins etait 100 a l'election)
  ]);
  const { deps } = buildResumeWeeklyDeps([], players, [], { p1: 100 }); // cible figee a l'election

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.equal(players.get("p1")!.weeklySnapshotCoins, 100, "le snapshot doit rester la cible figee a l'election (100), PAS les coins courants (120)");
  assert.equal(players.get("p1")!.coins, 120, "les +20 de gameplay restent sur le solde courant -- ils compteront pour le cycle SUIVANT");
});

test("resumeWeeklyRewards NOUVEAU 2. gagnant : gameplay entre election et reprise n'est jamais inclus dans le snapshot cible (coins=100 a l'election, bonus=500, +20 avant reprise, snapshot final=600)", async () => {
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 120, weeklySnapshotCoins: 50 }], // 100 a l'election + 20 de gameplay AVANT le payout du bonus
  ]);
  const { deps } = buildResumeWeeklyDeps([{ playerId: "p1", rank: 1, bonus: 500 }], players, [], { p1: 600 }); // 100 + 500, JAMAIS 120 + 500

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.equal(players.get("p1")!.coins, 620, "le payout s'ajoute au solde COURANT (120 + 500) -- coherent, coins n'est jamais fige");
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 600, "le snapshot reste la cible figee a l'election (600), PAS le solde courant post-payout (620)");
});

test("resumeWeeklyRewards NOUVEAU 3. crash apres l'election, puis gameplay, puis reprise(s) : la cible figee ne bouge jamais", async () => {
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 100, weeklySnapshotCoins: 50 }], // etat juste apres l'election, AVANT tout fan-out (crash immediat simule)
  ]);
  const fake1 = buildFakeClaimAndMutatePlayer(players);
  const deps1: WeeklyResumeDeps = {
    getWeeklyRewardAssignments: async () => [],
    getWeeklyCycleMembers: async () => ["p1"],
    getWeeklySnapshotTargets: async () => [{ playerId: "p1", target: 100 }],
    claimAndMutatePlayer: fake1.fn,
  };

  await resumeWeeklyRewards(CYCLE_ID, deps1);
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 100);

  // Gameplay APRES cette reprise (le joueur continue de jouer normalement).
  players.get("p1")!.coins += 30;

  // Reprise redondante (ex. scheduler qui repasse) : tout deja claim,
  // no-op -- la cible reste 100, jamais recalculee depuis les 130 courants.
  const fake2 = buildFakeClaimAndMutatePlayer(players, fake1.claimedKeys);
  const deps2: WeeklyResumeDeps = { ...deps1, claimAndMutatePlayer: fake2.fn };
  await resumeWeeklyRewards(CYCLE_ID, deps2);

  assert.equal(players.get("p1")!.weeklySnapshotCoins, 100, "la cible figee ne bouge jamais, meme apres du gameplay et une reprise redondante");
  assert.equal(players.get("p1")!.coins, 130, "les gains de gameplay restent sur le solde courant");
});

test("resumeWeeklyRewards NOUVEAU 4. crash apres le payout du gagnant mais avant son snapshot : gameplay entre-temps, reprise, aucun double bonus, cible initiale correcte", async () => {
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 620, weeklySnapshotCoins: 50 }], // 100(election) + 500(bonus deja applique) + 20(gameplay apres le bonus)
  ]);
  const { deps } = buildResumeWeeklyDeps(
    [{ playerId: "p1", rank: 1, bonus: 500 }],
    players,
    [`p1:${weeklyBonusPayoutClaimType(CYCLE_ID)}`], // bonus deja claim (payout du crash precedent)
    { p1: 600 }, // cible figee a l'election : 100 + 500, INDEPENDANTE des +20 de gameplay
  );

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.equal(players.get("p1")!.coins, 620, "aucun double bonus -- coins inchanges par ce second appel");
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 600, "la cible reste celle figee a l'election, jamais recalculee depuis les coins courants (620)");
});

test("resumeWeeklyRewards NOUVEAU 5. deux cycles : les cibles de snapshot sont totalement independantes l'une de l'autre", async () => {
  const players = new Map<string, FakePlayerFixture>([["p1", { userId: "p1", coins: 999, weeklySnapshotCoins: 0 }]]);

  const { deps: depsA } = buildResumeWeeklyDeps([], players, [], { p1: 111 });
  await resumeWeeklyRewards("cycle-cible-A", depsA);
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 111);

  const { deps: depsB } = buildResumeWeeklyDeps([], players, [], { p1: 222 });
  await resumeWeeklyRewards("cycle-cible-B", depsB);
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 222, "cycle B applique sa PROPRE cible, independamment de celle du cycle A");
});

test("resumeWeeklyRewards 9. redemarrage simule (aucun plan en memoire) : reprise possible uniquement depuis les lignes persistees (membres, assignations ET cibles de snapshot)", async () => {
  // Simule un redemarrage complet : ni les gagnants, ni la population, ni
  // les cibles de snapshot ne sont passes directement (comme le ferait
  // tryClaimWeeklyReset() en memoire) -- les TROIS sont relus depuis
  // reward_claims via getWeeklyRewardAssignments/getWeeklyCycleMembers/
  // getWeeklySnapshotTargets, exactement ce qu'un processus fraichement
  // redemarre ferait. p1 (gagnant) a une cible de 700 = 200(coinsAtElection)
  // + 500(bonus) ; p2 (non gagnant) a une cible de 90 = coinsAtElection.
  const rows: RewardClaim[] = [
    { id: 1, playerId: "p1", claimType: weeklyBonusAssignmentClaimType(CYCLE_ID, 1), claimedAt: NOW },
    { id: 2, playerId: "p1", claimType: weeklyMemberClaimType(CYCLE_ID), claimedAt: NOW },
    { id: 3, playerId: "p2", claimType: weeklyMemberClaimType(CYCLE_ID), claimedAt: NOW },
    { id: 4, playerId: "p1", claimType: weeklySnapshotTargetClaimType(CYCLE_ID, 700), claimedAt: NOW },
    { id: 5, playerId: "p2", claimType: weeklySnapshotTargetClaimType(CYCLE_ID, 90), claimedAt: NOW },
  ] as RewardClaim[];
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 200, weeklySnapshotCoins: 100 }],
    ["p2", { userId: "p2", coins: 90, weeklySnapshotCoins: 50 }],
  ]);
  const fake = buildFakeClaimAndMutatePlayer(players);

  const deps: WeeklyResumeDeps = {
    getWeeklyRewardAssignments: (cycleId: string) =>
      getWeeklyRewardAssignments(cycleId, {
        listRewardClaimsByPrefix: async (prefix) => rows.filter((r) => r.claimType.startsWith(prefix)),
      }),
    getWeeklyCycleMembers: (cycleId: string) =>
      getWeeklyCycleMembers(cycleId, {
        getRewardClaimsByExactType: async (claimType) => rows.filter((r) => r.claimType === claimType),
      }),
    getWeeklySnapshotTargets: (cycleId: string) =>
      getWeeklySnapshotTargets(cycleId, {
        listRewardClaimsByPrefix: async (prefix) => rows.filter((r) => r.claimType.startsWith(prefix)),
      }),
    claimAndMutatePlayer: fake.fn,
  };

  const result = await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.deepEqual(result.winners, [{ playerId: "p1", rank: 1, bonus: 500 }]);
  assert.equal(result.processedPlayerCount, 2);
  assert.equal(players.get("p1")!.coins, 700, "gagnant : bonus applique");
  assert.equal(players.get("p1")!.weeklySnapshotCoins, 700, "gagnant : snapshot = cible persistee (relue depuis PostgreSQL, pas recalculee)");
  assert.equal(players.get("p2")!.weeklySnapshotCoins, 90, "non gagnant : snapshot = cible persistee, aucun bonus");
});

test("resumeWeeklyRewards 10. un joueur present en base mais absent de la population figee (cree apres l'election) n'est jamais traite", async () => {
  // players contient p1 (membre du cycle) ET p_nouveau (cree APRES
  // l'election, PAS dans la population figee) -- seul getWeeklyCycleMembers
  // determine qui est traite, jamais un getAllPlayers() fraichement lu.
  const players = new Map<string, FakePlayerFixture>([
    ["p1", { userId: "p1", coins: 200, weeklySnapshotCoins: 100 }],
    ["p_nouveau", { userId: "p_nouveau", coins: 50, weeklySnapshotCoins: 50 }],
  ]);
  const fake = buildFakeClaimAndMutatePlayer(players);
  const deps: WeeklyResumeDeps = {
    getWeeklyRewardAssignments: async () => [],
    getWeeklyCycleMembers: async () => ["p1"], // p_nouveau volontairement absent
    getWeeklySnapshotTargets: async () => [{ playerId: "p1", target: 200 }], // p_nouveau volontairement absent egalement
    claimAndMutatePlayer: fake.fn,
  };

  await resumeWeeklyRewards(CYCLE_ID, deps);

  assert.equal(players.get("p1")!.weeklySnapshotCoins, 200, "membre du cycle : traite normalement");
  assert.equal(players.get("p_nouveau")!.weeklySnapshotCoins, 50, "jamais touche : absent de la population figee");
  assert.ok(!fake.claimedKeys.has(`p_nouveau:${weeklySnapshotClaimType(CYCLE_ID)}`));
});

// ===========================================================================
// getWeeklyCycleMembers
// ===========================================================================

test("getWeeklyCycleMembers : lit les lignes weekly-member par EGALITE STRICTE (pas de collision entre cycleId partiellement prefixes)", async () => {
  const rows: RewardClaim[] = [
    { id: 1, playerId: "p1", claimType: weeklyMemberClaimType("170"), claimedAt: NOW },
    { id: 2, playerId: "p2", claimType: weeklyMemberClaimType("1700000000000"), claimedAt: NOW }, // cycle DIFFERENT, ne doit jamais matcher "170"
  ] as RewardClaim[];
  const deps: GetWeeklyCycleMembersDeps = {
    getRewardClaimsByExactType: async (claimType) => rows.filter((r) => r.claimType === claimType),
  };

  const members = await getWeeklyCycleMembers("170", deps);

  assert.deepEqual(members, ["p1"], "seul le membre du cycle EXACT '170' doit etre retourne, jamais celui de '1700000000000'");
});

// ===========================================================================
// getWeeklySnapshotTargets
// ===========================================================================

test("getWeeklySnapshotTargets : lit les cibles via LIKE-prefixe, le ':' apres cycleId ecarte toute collision entre cycleId partiellement prefixes", async () => {
  const rows: RewardClaim[] = [
    { id: 1, playerId: "p1", claimType: weeklySnapshotTargetClaimType("170", 600), claimedAt: NOW },
    { id: 2, playerId: "p2", claimType: weeklySnapshotTargetClaimType("1700000000000", 999), claimedAt: NOW }, // cycle DIFFERENT, ne doit jamais matcher "170"
  ] as RewardClaim[];
  const listRewardClaimsByPrefix = mock.fn(async (prefix: string) => rows.filter((r) => r.claimType.startsWith(prefix)));

  const targets = await getWeeklySnapshotTargets("170", { listRewardClaimsByPrefix });

  assert.deepEqual(targets, [{ playerId: "p1", target: 600 }]);
});

test("getWeeklySnapshotTargets : une cible negative (coins inferieurs a l'ancien snapshot) est parsee sans ambiguite", async () => {
  const rows: RewardClaim[] = [
    { id: 1, playerId: "p1", claimType: weeklySnapshotTargetClaimType("170", -25), claimedAt: NOW },
  ] as RewardClaim[];
  const listRewardClaimsByPrefix = async (prefix: string) => rows.filter((r) => r.claimType.startsWith(prefix));

  const targets = await getWeeklySnapshotTargets("170", { listRewardClaimsByPrefix });

  assert.deepEqual(targets, [{ playerId: "p1", target: -25 }]);
});

// ===========================================================================
// getPendingWeeklyCycleIds -- decouverte multi-cycles, aucun etat memoire.
// ===========================================================================

function buildWeeklyClaim(playerId: string, claimType: string): RewardClaim {
  return { id: Math.random(), playerId, claimType, claimedAt: NOW } as RewardClaim;
}

test("getPendingWeeklyCycleIds 12. cycle entierement termine (tous membres snapshottes, tous gagnants payes) : absent du resultat", async () => {
  const cycleId = "cycle-complete";
  const claims: RewardClaim[] = [
    buildWeeklyClaim("p1", weeklyMemberClaimType(cycleId)),
    buildWeeklyClaim("p2", weeklyMemberClaimType(cycleId)),
    buildWeeklyClaim("p1", weeklyBonusAssignmentClaimType(cycleId, 1)),
    buildWeeklyClaim("p1", weeklySnapshotClaimType(cycleId)),
    buildWeeklyClaim("p2", weeklySnapshotClaimType(cycleId)),
    buildWeeklyClaim("p1", weeklyBonusPayoutClaimType(cycleId)),
  ];

  const pending = await getPendingWeeklyCycleIds({ listWeeklyClaims: async () => claims });

  assert.ok(!pending.includes(cycleId));
});

test("getPendingWeeklyCycleIds 4/5/6/7. cycle A partiellement distribue reste decouvrable independamment d'un cycle B (elu ensuite, egalement decouvrable)", async () => {
  const cycleA = "cycle-A";
  const cycleB = "cycle-B";
  const claims: RewardClaim[] = [
    // Cycle A : 2 membres, seul p1 a son snapshot -- INCOMPLET.
    buildWeeklyClaim("p1", weeklyMemberClaimType(cycleA)),
    buildWeeklyClaim("p2", weeklyMemberClaimType(cycleA)),
    buildWeeklyClaim("p1", weeklySnapshotClaimType(cycleA)),
    // Cycle B : elu plus tard, 1 membre, aucun snapshot -- INCOMPLET aussi.
    buildWeeklyClaim("p3", weeklyMemberClaimType(cycleB)),
  ];

  const pending = await getPendingWeeklyCycleIds({ listWeeklyClaims: async () => claims });

  assert.ok(pending.includes(cycleA), "le cycle A doit rester decouvrable malgre l'existence du cycle B");
  assert.ok(pending.includes(cycleB), "le cycle B doit aussi etre decouvrable");
  assert.equal(pending.length, 2);
});

test("getPendingWeeklyCycleIds : gagnant sans payout rend le cycle pending meme si tous les membres sont snapshottes", async () => {
  const cycleId = "cycle-gagnant-impaye";
  const claims: RewardClaim[] = [
    buildWeeklyClaim("p1", weeklyMemberClaimType(cycleId)),
    buildWeeklyClaim("p1", weeklySnapshotClaimType(cycleId)),
    buildWeeklyClaim("p1", weeklyBonusAssignmentClaimType(cycleId, 1)),
    // Pas de weekly-bonus-payout pour p1 -- toujours en attente.
  ];

  const pending = await getPendingWeeklyCycleIds({ listWeeklyClaims: async () => claims });

  assert.ok(pending.includes(cycleId));
});

test("getPendingWeeklyCycleIds : les lignes weekly-target (cibles de snapshot) n'affectent jamais la detection de completion", async () => {
  const cycleId = "cycle-avec-cibles";
  const claims: RewardClaim[] = [
    buildWeeklyClaim("p1", weeklyMemberClaimType(cycleId)),
    buildWeeklyClaim("p1", weeklySnapshotTargetClaimType(cycleId, 999)),
    buildWeeklyClaim("p1", weeklySnapshotClaimType(cycleId)),
  ];

  const pending = await getPendingWeeklyCycleIds({ listWeeklyClaims: async () => claims });

  assert.ok(
    !pending.includes(cycleId),
    "cycle complet (1 membre, 1 snapshot) : la presence d'une ligne weekly-target ne doit jamais empecher la detection de completion",
  );
});

test("getCurrentWeeklyCycleId : derive du weeklyStartedAt courant de getGlobalState()", async () => {
  const cycleId = await getCurrentWeeklyCycleId({
    getGlobalState: async () =>
      ({
        marketMultiplier: 1,
        previousMarketMultiplier: 1,
        marketUpdatedAt: 0,
        weather: "normal",
        weatherMultiplier: 1,
        weatherChangedAt: null,
        weatherExpiresAt: null,
        nextWeatherAt: 0,
        nextWeatherType: "rain",
        weeklyStartedAt: 1699000000000,
        dailyChallenge: {} as never,
        contract: {} as never,
      }) as never,
  });

  assert.equal(cycleId, "1699000000000");
});

test("getCurrentWeeklyCycleId : global_state absent -> null", async () => {
  const cycleId = await getCurrentWeeklyCycleId({ getGlobalState: async () => null });

  assert.equal(cycleId, null);
});

// ===========================================================================
// getUnrewardedCompletedDailyChallenges / resumeDailyChallengeReward --
// paiement d'abord, finalisation ensuite (correction du LOT 5).
// ===========================================================================

function buildDailyResumeDeps(overrides: Partial<DailyChallengeResumeDeps> = {}): DailyChallengeResumeDeps {
  return {
    getDailyChallengeById: async () => buildDailyChallengeRow(),
    getDailyChallengeContributors: async () => [
      { challengeId: 1, playerId: "p1", contributedAt: NOW },
      { challengeId: 1, playerId: "p2", contributedAt: NOW },
    ] as DailyChallengeContributor[],
    claimAndMutatePlayer: (async (playerId: string, _claimType: string, mutator: (p: PlayerState) => void) => {
      const player = { userId: playerId, coins: 0 } as unknown as PlayerState;
      mutator(player);
      return { claimed: true, player };
    }) as unknown as DailyChallengeResumeDeps["claimAndMutatePlayer"],
    tryFinalizeDailyChallengeRewarded: async () => true,
    ...overrides,
  };
}

test("getUnrewardedCompletedDailyChallenges 10. defi incomplet : exclu de la decouverte", async () => {
  const listUnrewardedCompletedDailyChallenges = mock.fn(
    async (): Promise<DailyChallengeRow[]> => [], // la vraie requete SQL exclut deja completed=false
  );
  const deps: GetUnrewardedCompletedDailyChallengesDeps = { listUnrewardedCompletedDailyChallenges };

  const result = await getUnrewardedCompletedDailyChallenges(deps);

  assert.deepEqual(result, []);
  assert.equal(listUnrewardedCompletedDailyChallenges.mock.calls.length, 1);
});

test("resumeDailyChallengeReward 10bis. defi non complete (appel direct defensif) : rejette, aucun paiement", async () => {
  const claimAndMutatePlayer = mock.fn(async () => ({ claimed: true, player: null }));
  const deps = buildDailyResumeDeps({
    getDailyChallengeById: async () => buildDailyChallengeRow({ completed: false }),
    claimAndMutatePlayer: claimAndMutatePlayer as unknown as DailyChallengeResumeDeps["claimAndMutatePlayer"],
  });

  await assert.rejects(() => resumeDailyChallengeReward(1, deps), /n'est pas "completed"/);
  assert.equal(claimAndMutatePlayer.mock.calls.length, 0);
});

test("resumeDailyChallengeReward 11. completed=true/rewarded=false : payouts effectues pour chaque contributeur, finalisation tentee", async () => {
  const claimAndMutatePlayer = mock.fn(
    async (playerId: string, _claimType: string, mutator: (p: PlayerState) => void) => {
      const player = { userId: playerId, coins: 0 } as unknown as PlayerState;
      mutator(player);
      return { claimed: true, player };
    },
  );
  const tryFinalizeDailyChallengeRewarded = mock.fn(async () => true);
  const deps = buildDailyResumeDeps({
    claimAndMutatePlayer: claimAndMutatePlayer as unknown as DailyChallengeResumeDeps["claimAndMutatePlayer"],
    tryFinalizeDailyChallengeRewarded,
  });

  const result = await resumeDailyChallengeReward(1, deps);

  assert.equal(result.challengeId, 1);
  assert.equal(result.rewardCoins, 80);
  assert.deepEqual(result.contributorIds, ["p1", "p2"]);
  assert.equal(result.finalized, true);
  assert.equal(claimAndMutatePlayer.mock.calls.length, 2);
  assert.deepEqual(
    claimAndMutatePlayer.mock.calls.map((call) => call.arguments[1]),
    [dailyChallengeRewardClaimType(1), dailyChallengeRewardClaimType(1)],
  );
  assert.equal(tryFinalizeDailyChallengeRewarded.mock.calls.length, 1);
});

test("resumeDailyChallengeReward 12. deux schedulers concurrents : aucun double paiement (simulation d'idempotence reelle)", async () => {
  const paidAmounts = new Map<string, number>();
  const claimedKeys = new Set<string>();
  const sharedClaimAndMutatePlayer = async (
    playerId: string,
    claimType: string,
    mutator: (p: { coins: number }) => void,
  ) => {
    const key = `${playerId}:${claimType}`;
    if (claimedKeys.has(key)) return { claimed: false, player: null };
    claimedKeys.add(key);
    const player = { coins: paidAmounts.get(playerId) ?? 0 };
    mutator(player);
    paidAmounts.set(playerId, player.coins);
    return { claimed: true, player: player as unknown as PlayerState };
  };
  let finalizedOnce = false;
  const sharedTryFinalize = async () => {
    if (finalizedOnce) return false;
    finalizedOnce = true;
    return true;
  };
  const deps = buildDailyResumeDeps({
    claimAndMutatePlayer: sharedClaimAndMutatePlayer as unknown as DailyChallengeResumeDeps["claimAndMutatePlayer"],
    tryFinalizeDailyChallengeRewarded: sharedTryFinalize,
  });

  const [resultA, resultB] = await Promise.all([resumeDailyChallengeReward(1, deps), resumeDailyChallengeReward(1, deps)]);

  assert.equal(paidAmounts.get("p1"), 80, "p1 ne doit avoir ete paye qu'une seule fois (80), jamais 160");
  assert.equal(paidAmounts.get("p2"), 80, "p2 ne doit avoir ete paye qu'une seule fois (80), jamais 160");
  const finalizedCount = [resultA.finalized, resultB.finalized].filter(Boolean).length;
  assert.equal(finalizedCount, 1, "un seul des deux appels doit gagner la finalisation");
});

test("resumeDailyChallengeReward 13. crash apres paiement partiel : reprise des seuls contributeurs manquants", async () => {
  const claimAndMutatePlayer = mock.fn(
    async (playerId: string, _claimType: string, mutator: (p: PlayerState) => void) => {
      if (playerId === "p1") return { claimed: false, player: null }; // deja paye lors d'un run precedent
      const player = { userId: playerId, coins: 0 } as unknown as PlayerState;
      mutator(player);
      return { claimed: true, player };
    },
  );
  const deps = buildDailyResumeDeps({
    claimAndMutatePlayer: claimAndMutatePlayer as unknown as DailyChallengeResumeDeps["claimAndMutatePlayer"],
  });

  const result = await resumeDailyChallengeReward(1, deps);

  assert.equal(claimAndMutatePlayer.mock.calls.length, 2, "les DEUX contributeurs sont tentes (idempotence gere le deja-paye)");
  assert.equal(result.finalized, true, "la finalisation doit quand meme reussir une fois tous les claims presents");
});

test("resumeDailyChallengeReward 14. echec pendant le fan-out (paiement qui echoue) : rejette, finalisation jamais tentee, rewarded reste false", async () => {
  const tryFinalizeDailyChallengeRewarded = mock.fn(async () => true);
  const deps = buildDailyResumeDeps({
    claimAndMutatePlayer: (async (playerId: string) => {
      if (playerId === "p2") throw new Error("echec simule pendant le paiement");
      return { claimed: true, player: null };
    }) as unknown as DailyChallengeResumeDeps["claimAndMutatePlayer"],
    tryFinalizeDailyChallengeRewarded,
  });

  await assert.rejects(() => resumeDailyChallengeReward(1, deps), /echec simule pendant le paiement/);
  assert.equal(tryFinalizeDailyChallengeRewarded.mock.calls.length, 0, "rewarded ne doit jamais etre finalise si un paiement a echoue");
});

test("resumeDailyChallengeReward 15. rewarded devient true seulement apres tous les payouts confirmes", async () => {
  const callOrder: string[] = [];
  const deps = buildDailyResumeDeps({
    claimAndMutatePlayer: (async (playerId: string) => {
      callOrder.push(`pay:${playerId}`);
      return { claimed: true, player: null };
    }) as unknown as DailyChallengeResumeDeps["claimAndMutatePlayer"],
    tryFinalizeDailyChallengeRewarded: async () => {
      callOrder.push("finalize");
      return true;
    },
  });

  const result = await resumeDailyChallengeReward(1, deps);

  assert.equal(result.finalized, true);
  assert.equal(callOrder[callOrder.length - 1], "finalize", "la finalisation doit toujours arriver EN DERNIER");
  assert.ok(callOrder.slice(0, -1).includes("pay:p1"));
  assert.ok(callOrder.slice(0, -1).includes("pay:p2"));
});

test("resumeDailyChallengeReward 16. un ancien defi non termine reste retrouvable et traitable independamment d'un defi suivant", async () => {
  // getDailyChallengeById(1) cible explicitement l'ANCIEN defi -- son
  // existence/traitement est totalement independant d'un defi id=2 plus
  // recent (table append-only, aucune ligne ecrasee ni perdue).
  const getDailyChallengeById = mock.fn(async (challengeId: number) =>
    buildDailyChallengeRow({ id: challengeId, rewardCoins: 80 }),
  );
  const deps = buildDailyResumeDeps({ getDailyChallengeById });

  const result = await resumeDailyChallengeReward(1, deps);

  assert.equal(result.challengeId, 1);
  assert.deepEqual(getDailyChallengeById.mock.calls[0]!.arguments, [1]);
});

test("resumeDailyChallengeReward 17. defi suivant utilise un claim_type distinct (pas de blocage entre defis)", async () => {
  assert.notEqual(dailyChallengeRewardClaimType(1), dailyChallengeRewardClaimType(2));

  const claimedKeys = new Set<string>();
  const sharedClaimAndMutatePlayer = async (playerId: string, claimType: string) => {
    const key = `${playerId}:${claimType}`;
    if (claimedKeys.has(key)) return { claimed: false, player: null };
    claimedKeys.add(key);
    return { claimed: true, player: null };
  };
  const deps1 = buildDailyResumeDeps({
    getDailyChallengeById: async () => buildDailyChallengeRow({ id: 1 }),
    getDailyChallengeContributors: async () => [{ challengeId: 1, playerId: "p1", contributedAt: NOW }] as DailyChallengeContributor[],
    claimAndMutatePlayer: sharedClaimAndMutatePlayer as unknown as DailyChallengeResumeDeps["claimAndMutatePlayer"],
  });
  const deps2 = buildDailyResumeDeps({
    getDailyChallengeById: async () => buildDailyChallengeRow({ id: 2 }),
    getDailyChallengeContributors: async () => [{ challengeId: 2, playerId: "p1", contributedAt: NOW }] as DailyChallengeContributor[],
    claimAndMutatePlayer: sharedClaimAndMutatePlayer as unknown as DailyChallengeResumeDeps["claimAndMutatePlayer"],
  });

  await resumeDailyChallengeReward(1, deps1);
  await resumeDailyChallengeReward(2, deps2);

  assert.ok(claimedKeys.has(`p1:${dailyChallengeRewardClaimType(1)}`));
  assert.ok(claimedKeys.has(`p1:${dailyChallengeRewardClaimType(2)}`), "le meme joueur doit pouvoir etre paye pour DEUX defis differents");
});

// ===========================================================================
// claimReadyPlotNotification
// ===========================================================================

function buildNotificationDeps(overrides: Partial<ClaimReadyPlotNotificationDeps> = {}): ClaimReadyPlotNotificationDeps {
  return {
    tryClaimNotifiedReady: async () => true,
    ...overrides,
  };
}

test("claimReadyPlotNotification 1. plot non pret (now < readyAt) : claimed=false, aucun appel DB tente", async () => {
  const tryClaimNotifiedReady = mock.fn(
    async (..._args: Parameters<ClaimReadyPlotNotificationDeps["tryClaimNotifiedReady"]>) => true,
  );
  const deps = buildNotificationDeps({ tryClaimNotifiedReady });

  const result = await claimReadyPlotNotification(TEST_PLAYER_ID, 0, NOW.getTime(), NOW.getTime() + 60_000, NOW.getTime(), deps);

  assert.equal(result.claimed, false);
  assert.equal(tryClaimNotifiedReady.mock.calls.length, 0);
});

test("claimReadyPlotNotification 2. plot pret et notifiedReady=false (simule) : 1 claim, arguments corrects", async () => {
  const tryClaimNotifiedReady = mock.fn(
    async (..._args: Parameters<ClaimReadyPlotNotificationDeps["tryClaimNotifiedReady"]>) => true,
  );
  const deps = buildNotificationDeps({ tryClaimNotifiedReady });

  const result = await claimReadyPlotNotification(TEST_PLAYER_ID, 2, NOW.getTime(), NOW.getTime() - 1000, NOW.getTime(), deps);

  assert.equal(result.claimed, true);
  assert.equal(tryClaimNotifiedReady.mock.calls.length, 1);
  assert.deepEqual(tryClaimNotifiedReady.mock.calls[0]!.arguments, [TEST_PLAYER_ID, 2, NOW.getTime()]);
});

test("claimReadyPlotNotification 3. deuxieme appel / plot vide / deja notifie (simule par le mock) : aucun claim", async () => {
  const deps = buildNotificationDeps({ tryClaimNotifiedReady: async () => false });

  const result = await claimReadyPlotNotification(TEST_PLAYER_ID, 0, NOW.getTime(), NOW.getTime() - 1000, NOW.getTime(), deps);

  assert.equal(result.claimed, false);
});

test("claimReadyPlotNotification 4. deux appels concurrents : un seul gagnant (simulation d'une CAS reelle avec etat partage)", async () => {
  let claimedOnce = false;
  const deps = buildNotificationDeps({
    tryClaimNotifiedReady: async () => {
      if (claimedOnce) return false;
      claimedOnce = true;
      return true;
    },
  });

  const [resultA, resultB] = await Promise.all([
    claimReadyPlotNotification(TEST_PLAYER_ID, 1, NOW.getTime(), NOW.getTime() - 1000, NOW.getTime(), deps),
    claimReadyPlotNotification(TEST_PLAYER_ID, 1, NOW.getTime(), NOW.getTime() - 1000, NOW.getTime(), deps),
  ]);

  const claimedCount = [resultA, resultB].filter((r) => r.claimed).length;
  assert.equal(claimedCount, 1);
});

test("claimReadyPlotNotification 5. now == readyAt (limite) : considere pret, tente le claim", async () => {
  const tryClaimNotifiedReady = mock.fn(
    async (..._args: Parameters<ClaimReadyPlotNotificationDeps["tryClaimNotifiedReady"]>) => true,
  );
  const deps = buildNotificationDeps({ tryClaimNotifiedReady });

  const result = await claimReadyPlotNotification(TEST_PLAYER_ID, 0, NOW.getTime(), NOW.getTime(), NOW.getTime(), deps);

  assert.equal(result.claimed, true);
  assert.equal(tryClaimNotifiedReady.mock.calls.length, 1);
});

// ===========================================================================
// Garanties transversales du LOT 5
// ===========================================================================

test("farmRepository.ts (LOT 5 inclus) n'importe ni FarmStore/getFarmStore, ni discord.js/express, aucun DELETE", async () => {
  const filePath = new URL("./farmRepository.ts", import.meta.url);
  const source = await readFile(filePath, "utf8");
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line))
    .join("\n");

  assert.ok(!/FarmStore/.test(importLines), "aucun import de FarmStore attendu");
  assert.ok(!/getFarmStore/.test(importLines), "aucun import de getFarmStore attendu");
  assert.ok(!/discord\.js/.test(importLines), "aucune dependance discord.js attendue");
  assert.ok(!/["']express["']/.test(importLines), "aucune dependance express attendue");
  assert.ok(!/\.delete\(/.test(source), "aucun .delete( attendu dans farmRepository.ts");
  assert.ok(!/\.drop\(|DROP TABLE|TRUNCATE/i.test(source), "aucun DROP/TRUNCATE attendu dans farmRepository.ts");
});
