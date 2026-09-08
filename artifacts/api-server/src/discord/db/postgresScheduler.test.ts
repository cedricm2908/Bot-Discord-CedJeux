// Tests du module d'orchestration du scheduler runtime PostgreSQL (LOT
// SCHEDULER 1). Aucune connexion Neon/Railway -- uniquement des deps
// mockees/injectees, meme convention que le reste de ce dossier
// (farmRepository.test.ts/farmRepositoryClaims.test.ts/farmPlayerActions.test.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import {
  POSTGRES_SCHEDULER_ENABLED_ENV_VAR,
  createPostgresSchedulerTickRunner,
  isPostgresSchedulerEnabled,
  runPostgresSchedulerTick,
  type PostgresSchedulerDeps,
  type ReadyPlotNotification,
} from "./postgresScheduler.ts";
import type { GlobalState, PlayerState, Plot } from "../types";

const NOW = 1_700_000_000_000;
const TEST_PLAYER_ID = "440158020274618378";

function buildPlot(overrides: Partial<Plot> = {}): Plot {
  return { cropId: null, plantedAt: null, notifiedReady: false, ...overrides };
}

function buildPlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    userId: TEST_PLAYER_ID,
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
    marketMultiplier: 1,
    previousMarketMultiplier: 1,
    marketUpdatedAt: NOW,
    weather: "normal",
    weatherMultiplier: 1,
    weatherChangedAt: null,
    weatherExpiresAt: null,
    nextWeatherAt: NOW + 60 * 60 * 1000,
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

function buildDeps(overrides: Partial<PostgresSchedulerDeps> = {}): PostgresSchedulerDeps {
  return {
    mutateGlobalState: mock.fn(async (mutator: (g: GlobalState) => void | Promise<void>) => {
      const global = buildGlobalState();
      await mutator(global);
      return global;
    }) as unknown as PostgresSchedulerDeps["mutateGlobalState"],
    tryClaimWeeklyReset: mock.fn(async () => ({ claimed: false as const })) as unknown as PostgresSchedulerDeps["tryClaimWeeklyReset"],
    resumeWeeklyRewards: mock.fn(async (cycleId: string) => ({ cycleId, winners: [], processedPlayerCount: 0 })) as unknown as PostgresSchedulerDeps["resumeWeeklyRewards"],
    getPendingWeeklyCycleIds: mock.fn(async () => [] as string[]) as unknown as PostgresSchedulerDeps["getPendingWeeklyCycleIds"],
    getUnrewardedCompletedDailyChallenges: mock.fn(async () => []) as unknown as PostgresSchedulerDeps["getUnrewardedCompletedDailyChallenges"],
    resumeDailyChallengeReward: mock.fn(async (challengeId: number) => ({
      challengeId,
      rewardCoins: 0,
      contributorIds: [],
      finalized: true,
    })) as unknown as PostgresSchedulerDeps["resumeDailyChallengeReward"],
    getAllPlayers: mock.fn(async () => [] as PlayerState[]) as unknown as PostgresSchedulerDeps["getAllPlayers"],
    claimReadyPlotNotification: mock.fn(async () => ({ claimed: false })) as unknown as PostgresSchedulerDeps["claimReadyPlotNotification"],
    sendReadyNotification: mock.fn(async () => {}) as unknown as PostgresSchedulerDeps["sendReadyNotification"],
    now: () => NOW,
    ...overrides,
  };
}

// ===========================================================================
// 1. Global state
// ===========================================================================

test("runPostgresSchedulerTick 1. etape global-state : mutateGlobalState() appelee exactement une fois, avec un mutator qui applique reellement enrichGlobalState() (verifie via un GlobalState perime)", async () => {
  const mutateGlobalState = mock.fn(async (mutator: (g: GlobalState) => void | Promise<void>) => {
    const staleGlobal = buildGlobalState({ marketUpdatedAt: 0 });
    await mutator(staleGlobal);
    return staleGlobal;
  });
  const deps = buildDeps({ mutateGlobalState: mutateGlobalState as unknown as PostgresSchedulerDeps["mutateGlobalState"] });

  await runPostgresSchedulerTick(deps);

  assert.equal(mutateGlobalState.mock.calls.length, 1);
  // marketUpdatedAt=0 (perime depuis longtemps) : si le mutator applique
  // reellement enrichGlobalState(), marketUpdatedAt doit avoir change.
  const [mutatorArg] = mutateGlobalState.mock.calls[0]!.arguments;
  const probeGlobal = buildGlobalState({ marketUpdatedAt: 0 });
  await mutatorArg(probeGlobal);
  assert.notEqual(probeGlobal.marketUpdatedAt, 0, "le mutator doit reellement appeler enrichGlobalState(), pas un no-op");
});

// ===========================================================================
// 2-5. Weekly
// ===========================================================================

test("runPostgresSchedulerTick 2. weekly election appelee (tryClaimWeeklyReset), non gagnee : resumeWeeklyRewards jamais appele", async () => {
  const tryClaimWeeklyReset = mock.fn(async () => ({ claimed: false as const }));
  const resumeWeeklyRewards = mock.fn(async (cycleId: string) => ({ cycleId, winners: [], processedPlayerCount: 0 }));
  const deps = buildDeps({
    tryClaimWeeklyReset: tryClaimWeeklyReset as unknown as PostgresSchedulerDeps["tryClaimWeeklyReset"],
    resumeWeeklyRewards: resumeWeeklyRewards as unknown as PostgresSchedulerDeps["resumeWeeklyRewards"],
  });

  await runPostgresSchedulerTick(deps);

  assert.equal(tryClaimWeeklyReset.mock.calls.length, 1);
  assert.equal(resumeWeeklyRewards.mock.calls.length, 0);
});

test("runPostgresSchedulerTick 3. claimed=true -> resumeWeeklyRewards(cycleId) appele avec le bon cycleId", async () => {
  const tryClaimWeeklyReset = mock.fn(async () => ({
    claimed: true as const,
    cycleId: "cycle-A",
    winners: [],
    allPlayerIds: [],
  }));
  const resumeWeeklyRewards = mock.fn(async (cycleId: string) => ({ cycleId, winners: [], processedPlayerCount: 0 }));
  const deps = buildDeps({
    tryClaimWeeklyReset: tryClaimWeeklyReset as unknown as PostgresSchedulerDeps["tryClaimWeeklyReset"],
    resumeWeeklyRewards: resumeWeeklyRewards as unknown as PostgresSchedulerDeps["resumeWeeklyRewards"],
  });

  await runPostgresSchedulerTick(deps);

  assert.equal(resumeWeeklyRewards.mock.calls.length, 1);
  assert.equal(resumeWeeklyRewards.mock.calls[0]!.arguments[0], "cycle-A");
});

test("runPostgresSchedulerTick 4. getPendingWeeklyCycleIds -> resumeWeeklyRewards appele pour chaque cycle en attente", async () => {
  const getPendingWeeklyCycleIds = mock.fn(async () => ["cycle-B"]);
  const resumeWeeklyRewards = mock.fn(async (cycleId: string) => ({ cycleId, winners: [], processedPlayerCount: 0 }));
  const deps = buildDeps({
    getPendingWeeklyCycleIds: getPendingWeeklyCycleIds as unknown as PostgresSchedulerDeps["getPendingWeeklyCycleIds"],
    resumeWeeklyRewards: resumeWeeklyRewards as unknown as PostgresSchedulerDeps["resumeWeeklyRewards"],
  });

  await runPostgresSchedulerTick(deps);

  assert.equal(resumeWeeklyRewards.mock.calls.length, 1);
  assert.equal(resumeWeeklyRewards.mock.calls[0]!.arguments[0], "cycle-B");
});

test("runPostgresSchedulerTick 5. pas de double resume inutile du meme cycle dans un tick : cycle gagne par l'election ET present dans les pending -> resumeWeeklyRewards appele une seule fois pour lui, l'idempotence DB reste la garantie de fond", async () => {
  const tryClaimWeeklyReset = mock.fn(async () => ({
    claimed: true as const,
    cycleId: "cycle-C",
    winners: [],
    allPlayerIds: [],
  }));
  const getPendingWeeklyCycleIds = mock.fn(async () => ["cycle-C", "cycle-D"]);
  const resumeWeeklyRewards = mock.fn(async (cycleId: string) => ({ cycleId, winners: [], processedPlayerCount: 0 }));
  const deps = buildDeps({
    tryClaimWeeklyReset: tryClaimWeeklyReset as unknown as PostgresSchedulerDeps["tryClaimWeeklyReset"],
    getPendingWeeklyCycleIds: getPendingWeeklyCycleIds as unknown as PostgresSchedulerDeps["getPendingWeeklyCycleIds"],
    resumeWeeklyRewards: resumeWeeklyRewards as unknown as PostgresSchedulerDeps["resumeWeeklyRewards"],
  });

  await runPostgresSchedulerTick(deps);

  assert.equal(resumeWeeklyRewards.mock.calls.length, 2, "cycle-C (election) + cycle-D (pending) -- jamais cycle-C deux fois");
  const calledCycleIds = resumeWeeklyRewards.mock.calls.map((call) => call.arguments[0]);
  assert.deepEqual(calledCycleIds, ["cycle-C", "cycle-D"]);
});

test("runPostgresSchedulerTick 5b. isolation par element weekly pending : cycle A jette, cycle B doit quand meme etre resume", async () => {
  const getPendingWeeklyCycleIds = mock.fn(async () => ["cycle-A", "cycle-B"]);
  const resumeWeeklyRewards = mock.fn(async (cycleId: string) => {
    if (cycleId === "cycle-A") throw new Error("panne cycle-A simulee");
    return { cycleId, winners: [], processedPlayerCount: 0 };
  });
  const deps = buildDeps({
    getPendingWeeklyCycleIds: getPendingWeeklyCycleIds as unknown as PostgresSchedulerDeps["getPendingWeeklyCycleIds"],
    resumeWeeklyRewards: resumeWeeklyRewards as unknown as PostgresSchedulerDeps["resumeWeeklyRewards"],
  });

  await assert.doesNotReject(() => runPostgresSchedulerTick(deps));

  assert.equal(resumeWeeklyRewards.mock.calls.length, 2, "cycle-A (echoue) puis cycle-B (reussit) doivent tous les deux etre tentes");
  assert.deepEqual(
    resumeWeeklyRewards.mock.calls.map((call) => call.arguments[0]),
    ["cycle-A", "cycle-B"],
  );
});

// ===========================================================================
// 6. Daily
// ===========================================================================

test("runPostgresSchedulerTick 6. getUnrewardedCompletedDailyChallenges -> resumeDailyChallengeReward appele pour chaque defi", async () => {
  const getUnrewardedCompletedDailyChallenges = mock.fn(async () => [{ id: 1 }, { id: 2 }] as never[]);
  const resumeDailyChallengeReward = mock.fn(async (challengeId: number) => ({
    challengeId,
    rewardCoins: 0,
    contributorIds: [],
    finalized: true,
  }));
  const deps = buildDeps({
    getUnrewardedCompletedDailyChallenges: getUnrewardedCompletedDailyChallenges as unknown as PostgresSchedulerDeps["getUnrewardedCompletedDailyChallenges"],
    resumeDailyChallengeReward: resumeDailyChallengeReward as unknown as PostgresSchedulerDeps["resumeDailyChallengeReward"],
  });

  await runPostgresSchedulerTick(deps);

  assert.equal(resumeDailyChallengeReward.mock.calls.length, 2);
  assert.deepEqual(resumeDailyChallengeReward.mock.calls.map((call) => call.arguments[0]), [1, 2]);
});

test("runPostgresSchedulerTick 6b. isolation par element daily : defi A jette, defi B doit quand meme etre recompense", async () => {
  const getUnrewardedCompletedDailyChallenges = mock.fn(async () => [{ id: 1 }, { id: 2 }] as never[]);
  const resumeDailyChallengeReward = mock.fn(async (challengeId: number) => {
    if (challengeId === 1) throw new Error("panne defi 1 simulee");
    return { challengeId, rewardCoins: 0, contributorIds: [], finalized: true };
  });
  const deps = buildDeps({
    getUnrewardedCompletedDailyChallenges: getUnrewardedCompletedDailyChallenges as unknown as PostgresSchedulerDeps["getUnrewardedCompletedDailyChallenges"],
    resumeDailyChallengeReward: resumeDailyChallengeReward as unknown as PostgresSchedulerDeps["resumeDailyChallengeReward"],
  });

  await assert.doesNotReject(() => runPostgresSchedulerTick(deps));

  assert.equal(resumeDailyChallengeReward.mock.calls.length, 2, "defi 1 (echoue) puis defi 2 (reussit) doivent tous les deux etre tentes");
  assert.deepEqual(
    resumeDailyChallengeReward.mock.calls.map((call) => call.arguments[0]),
    [1, 2],
  );
});

// ===========================================================================
// 7-9. Isolation des erreurs entre etapes
// ===========================================================================

test("runPostgresSchedulerTick 7. erreur a l'etape global-state n'empeche pas weekly ni daily d'etre tentes", async () => {
  const mutateGlobalState = mock.fn(async () => {
    throw new Error("panne globale simulee");
  });
  const tryClaimWeeklyReset = mock.fn(async () => ({ claimed: false as const }));
  const getUnrewardedCompletedDailyChallenges = mock.fn(async () => []);
  const deps = buildDeps({
    mutateGlobalState: mutateGlobalState as unknown as PostgresSchedulerDeps["mutateGlobalState"],
    tryClaimWeeklyReset: tryClaimWeeklyReset as unknown as PostgresSchedulerDeps["tryClaimWeeklyReset"],
    getUnrewardedCompletedDailyChallenges: getUnrewardedCompletedDailyChallenges as unknown as PostgresSchedulerDeps["getUnrewardedCompletedDailyChallenges"],
  });

  await assert.doesNotReject(() => runPostgresSchedulerTick(deps));

  assert.equal(tryClaimWeeklyReset.mock.calls.length, 1);
  assert.equal(getUnrewardedCompletedDailyChallenges.mock.calls.length, 1);
});

test("runPostgresSchedulerTick 8. erreur a l'etape weekly (election) n'empeche pas daily d'etre tente", async () => {
  const tryClaimWeeklyReset = mock.fn(async () => {
    throw new Error("panne weekly simulee");
  });
  const getUnrewardedCompletedDailyChallenges = mock.fn(async () => []);
  const deps = buildDeps({
    tryClaimWeeklyReset: tryClaimWeeklyReset as unknown as PostgresSchedulerDeps["tryClaimWeeklyReset"],
    getUnrewardedCompletedDailyChallenges: getUnrewardedCompletedDailyChallenges as unknown as PostgresSchedulerDeps["getUnrewardedCompletedDailyChallenges"],
  });

  await assert.doesNotReject(() => runPostgresSchedulerTick(deps));

  assert.equal(getUnrewardedCompletedDailyChallenges.mock.calls.length, 1);
});

test("runPostgresSchedulerTick 9. erreur a l'etape daily n'empeche pas l'etape ready-plot-notifications d'etre tentee", async () => {
  const getUnrewardedCompletedDailyChallenges = mock.fn(async () => {
    throw new Error("panne daily simulee");
  });
  const getAllPlayers = mock.fn(async () => [] as PlayerState[]);
  const deps = buildDeps({
    getUnrewardedCompletedDailyChallenges: getUnrewardedCompletedDailyChallenges as unknown as PostgresSchedulerDeps["getUnrewardedCompletedDailyChallenges"],
    getAllPlayers: getAllPlayers as unknown as PostgresSchedulerDeps["getAllPlayers"],
  });

  await assert.doesNotReject(() => runPostgresSchedulerTick(deps));

  assert.equal(getAllPlayers.mock.calls.length, 1);
});

// ===========================================================================
// 10-12. Ready plot notifications
// ===========================================================================

test("runPostgresSchedulerTick 10. parcelle prete, claim reussi (claimed=true) : exactement UN envoi de notification, avec la bonne parcelle", async () => {
  const readyPlot = buildPlot({ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const player = buildPlayerState({ plots: [readyPlot] });
  const getAllPlayers = mock.fn(async () => [player]);
  const claimReadyPlotNotification = mock.fn(async () => ({ claimed: true }));
  const sendReadyNotification = mock.fn(async (_playerId: string, _plots: ReadyPlotNotification[]) => {});
  const deps = buildDeps({
    getAllPlayers: getAllPlayers as unknown as PostgresSchedulerDeps["getAllPlayers"],
    claimReadyPlotNotification: claimReadyPlotNotification as unknown as PostgresSchedulerDeps["claimReadyPlotNotification"],
    sendReadyNotification: sendReadyNotification as unknown as PostgresSchedulerDeps["sendReadyNotification"],
  });

  await runPostgresSchedulerTick(deps);

  assert.equal(claimReadyPlotNotification.mock.calls.length, 1);
  assert.equal(sendReadyNotification.mock.calls.length, 1);
  const [playerId, readyPlots] = sendReadyNotification.mock.calls[0]!.arguments;
  assert.equal(playerId, TEST_PLAYER_ID);
  assert.deepEqual(readyPlots, [{ cropId: "wheat", plotIndex: 0 }]);
});

test("runPostgresSchedulerTick 11. claim echoue (claimed=false) : aucun envoi de notification", async () => {
  const readyPlot = buildPlot({ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const player = buildPlayerState({ plots: [readyPlot] });
  const getAllPlayers = mock.fn(async () => [player]);
  const claimReadyPlotNotification = mock.fn(async () => ({ claimed: false }));
  const sendReadyNotification = mock.fn(async () => {});
  const deps = buildDeps({
    getAllPlayers: getAllPlayers as unknown as PostgresSchedulerDeps["getAllPlayers"],
    claimReadyPlotNotification: claimReadyPlotNotification as unknown as PostgresSchedulerDeps["claimReadyPlotNotification"],
    sendReadyNotification: sendReadyNotification as unknown as PostgresSchedulerDeps["sendReadyNotification"],
  });

  await runPostgresSchedulerTick(deps);

  assert.equal(claimReadyPlotNotification.mock.calls.length, 1);
  assert.equal(sendReadyNotification.mock.calls.length, 0);
});

test("runPostgresSchedulerTick 12. l'envoi DM d'un joueur qui echoue ne fait pas crasher le tick, et n'empeche pas le joueur suivant d'etre traite", async () => {
  const readyPlotA = buildPlot({ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const readyPlotB = buildPlot({ cropId: "carrot", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const playerA = buildPlayerState({ userId: "player-a", plots: [readyPlotA] });
  const playerB = buildPlayerState({ userId: "player-b", plots: [readyPlotB] });
  const getAllPlayers = mock.fn(async () => [playerA, playerB]);
  const claimReadyPlotNotification = mock.fn(async () => ({ claimed: true }));
  const sendReadyNotification = mock.fn(async (playerId: string) => {
    if (playerId === "player-a") throw new Error("DM refuse par le joueur A");
  });
  const deps = buildDeps({
    getAllPlayers: getAllPlayers as unknown as PostgresSchedulerDeps["getAllPlayers"],
    claimReadyPlotNotification: claimReadyPlotNotification as unknown as PostgresSchedulerDeps["claimReadyPlotNotification"],
    sendReadyNotification: sendReadyNotification as unknown as PostgresSchedulerDeps["sendReadyNotification"],
  });

  await assert.doesNotReject(() => runPostgresSchedulerTick(deps));

  assert.equal(sendReadyNotification.mock.calls.length, 2, "les deux joueurs doivent etre tentes, l'echec du premier n'arrete pas la boucle");
  assert.equal(sendReadyNotification.mock.calls[1]!.arguments[0], "player-b");
});

test("runPostgresSchedulerTick 12b. isolation par element ready-plot (meme joueur) : claim parcelle 0 jette, parcelle 1 doit quand meme etre reclamee, et le DM ne contient que la parcelle reclamee avec succes", async () => {
  const plot0 = buildPlot({ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const plot1 = buildPlot({ cropId: "carrot", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const player = buildPlayerState({ plots: [plot0, plot1] });
  const getAllPlayers = mock.fn(async () => [player]);
  const claimReadyPlotNotification = mock.fn(async (_playerId: string, plotIndex: number) => {
    if (plotIndex === 0) throw new Error("panne claim parcelle 0 simulee");
    return { claimed: true };
  });
  const sendReadyNotification = mock.fn(async (_playerId: string, _plots: ReadyPlotNotification[]) => {});
  const deps = buildDeps({
    getAllPlayers: getAllPlayers as unknown as PostgresSchedulerDeps["getAllPlayers"],
    claimReadyPlotNotification: claimReadyPlotNotification as unknown as PostgresSchedulerDeps["claimReadyPlotNotification"],
    sendReadyNotification: sendReadyNotification as unknown as PostgresSchedulerDeps["sendReadyNotification"],
  });

  await assert.doesNotReject(() => runPostgresSchedulerTick(deps));

  assert.equal(claimReadyPlotNotification.mock.calls.length, 2, "les deux parcelles doivent etre tentees, l'echec de la premiere n'arrete pas la boucle");
  assert.equal(sendReadyNotification.mock.calls.length, 1);
  const [, readyPlots] = sendReadyNotification.mock.calls[0]!.arguments;
  assert.deepEqual(readyPlots, [{ cropId: "carrot", plotIndex: 1 }], "seule la parcelle reclamee avec succes doit figurer dans le DM");
});

test("runPostgresSchedulerTick 12c. isolation par element ready-plot (multi-joueurs) : claim d'une parcelle du joueur A jette, le joueur B doit quand meme etre traite", async () => {
  const plotA = buildPlot({ cropId: "wheat", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const plotB = buildPlot({ cropId: "carrot", plantedAt: NOW - 10 * 60 * 1000, notifiedReady: false });
  const playerA = buildPlayerState({ userId: "player-a", plots: [plotA] });
  const playerB = buildPlayerState({ userId: "player-b", plots: [plotB] });
  const getAllPlayers = mock.fn(async () => [playerA, playerB]);
  const claimReadyPlotNotification = mock.fn(async (playerId: string) => {
    if (playerId === "player-a") throw new Error("panne claim joueur A simulee");
    return { claimed: true };
  });
  const sendReadyNotification = mock.fn(async (_playerId: string, _plots: ReadyPlotNotification[]) => {});
  const deps = buildDeps({
    getAllPlayers: getAllPlayers as unknown as PostgresSchedulerDeps["getAllPlayers"],
    claimReadyPlotNotification: claimReadyPlotNotification as unknown as PostgresSchedulerDeps["claimReadyPlotNotification"],
    sendReadyNotification: sendReadyNotification as unknown as PostgresSchedulerDeps["sendReadyNotification"],
  });

  await assert.doesNotReject(() => runPostgresSchedulerTick(deps));

  assert.equal(claimReadyPlotNotification.mock.calls.length, 2, "les deux joueurs doivent etre tentes");
  assert.equal(sendReadyNotification.mock.calls.length, 1, "seul le joueur B (claim reussi) recoit un DM");
  assert.equal(sendReadyNotification.mock.calls[0]!.arguments[0], "player-b");
});

// ===========================================================================
// 13. Activation fail-closed
// ===========================================================================

test("isPostgresSchedulerEnabled : true UNIQUEMENT pour la chaine exacte \"true\" -- aucune normalisation (pas de trim, pas de lowercase)", () => {
  assert.equal(isPostgresSchedulerEnabled({ [POSTGRES_SCHEDULER_ENABLED_ENV_VAR]: "true" }), true);

  for (const value of [undefined, "", "false", "0", "yes", "1", "TRUE", "True", " true", "true ", "TrUe"]) {
    assert.equal(
      isPostgresSchedulerEnabled({ [POSTGRES_SCHEDULER_ENABLED_ENV_VAR]: value }),
      false,
      `attendu desactive pour la valeur ${JSON.stringify(value)}`,
    );
  }
});

test("isPostgresSchedulerEnabled : sans env fourni, lit process.env (aucune valeur par defaut ne doit y etre exactement \"true\" pendant les tests)", () => {
  const original = process.env[POSTGRES_SCHEDULER_ENABLED_ENV_VAR];
  try {
    delete process.env[POSTGRES_SCHEDULER_ENABLED_ENV_VAR];
    assert.equal(isPostgresSchedulerEnabled(), false);
  } finally {
    if (original === undefined) delete process.env[POSTGRES_SCHEDULER_ENABLED_ENV_VAR];
    else process.env[POSTGRES_SCHEDULER_ENABLED_ENV_VAR] = original;
  }
});

// ===========================================================================
// 14. Anti-chevauchement (local au process)
// ===========================================================================

test("createPostgresSchedulerTickRunner : un deuxieme declenchement pendant qu'un tick est encore en cours est ignore ; un declenchement APRES la fin du premier tick s'execute normalement", async () => {
  let resolveFirstTick!: () => void;
  const firstTickGate = new Promise<void>((resolve) => {
    resolveFirstTick = resolve;
  });
  const mutateGlobalState = mock.fn(async (mutator: (g: GlobalState) => void | Promise<void>) => {
    await firstTickGate;
    const global = buildGlobalState();
    await mutator(global);
    return global;
  });
  const deps = buildDeps({ mutateGlobalState: mutateGlobalState as unknown as PostgresSchedulerDeps["mutateGlobalState"] });
  const runTick = createPostgresSchedulerTickRunner(deps);

  const firstCall = runTick();
  const secondCall = runTick(); // declenche pendant que le premier est bloque sur firstTickGate

  await secondCall;
  assert.equal(mutateGlobalState.mock.calls.length, 1, "le deuxieme declenchement, concurrent au premier, ne doit rien executer");

  resolveFirstTick();
  await firstCall;

  await runTick(); // troisieme declenchement, APRES la fin du premier -- doit s'executer normalement
  assert.equal(mutateGlobalState.mock.calls.length, 2, "un declenchement apres la fin du tick precedent doit s'executer normalement");
});

// ===========================================================================
// 15. Independance vis-a-vis de FarmStore/sharedStore/discord.js
// ===========================================================================

test("postgresScheduler.ts n'importe ni ./store, ni ./sharedStore, ni discord.js -- module DB-only, jamais de Client Discord cree ici", async () => {
  const source = await readFile(new URL("./postgresScheduler.ts", import.meta.url), "utf8");
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line))
    .join("\n");

  assert.ok(!/from ["']\.\/store/.test(importLines), "aucun import de ./store attendu");
  assert.ok(!/from ["']\.\/sharedStore/.test(importLines), "aucun import de ./sharedStore attendu");
  assert.ok(!/from ["']discord\.js["']/.test(importLines), "aucun import de discord.js attendu");
  assert.ok(!/new Client\(/.test(source), "aucune creation de Client discord.js attendue dans ce module");
});
