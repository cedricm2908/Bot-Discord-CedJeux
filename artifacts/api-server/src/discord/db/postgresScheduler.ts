// Orchestration du scheduler runtime PostgreSQL (LOT SCHEDULER 1). Ce
// module ne fait qu'APPELER, dans un ordre precis, des primitives DEJA
// existantes et DEJA testees (farmRepository.ts, LOT5) et des fonctions
// metier V1 PURES (../farm.ts, jamais modifiees) -- AUCUNE regle metier
// n'est reimplementee ici (memes formules de meteo/marche/contrat/defi
// quotidien/hebdomadaire/temps de pousse que V1, reutilisees telles
// quelles). Independant de Discord (aucun import discord.js, aucune
// creation de Client) et independant de FarmStore/JSON (aucun import de
// ./store ou ./sharedStore) -- coexiste avec le scheduler JSON V1 existant
// (bot.ts), qui reste totalement inchange.
//
// L'idempotence/la surete multi-replica ne vient PAS de ce module (qui ne
// fait aucune coordination inter-process) mais des primitives LOT5
// elles-memes (verrous de ligne, CAS optimistes, contrainte UNIQUE
// reward_claims) -- voir leurs propres commentaires dans farmRepository.ts.
// Ce module ajoute seulement une protection anti-chevauchement LOCALE AU
// PROCESS (voir createPostgresSchedulerTickRunner ci-dessous), qui evite
// un gaspillage de travail dans le MEME process, mais ne remplace en rien
// cette surete DB.
import { enrichGlobalState, growMinutes, isReady } from "../farm.ts";
import { logger } from "../../lib/logger.ts";
import {
  claimReadyPlotNotification,
  getAllPlayers,
  getPendingWeeklyCycleIds,
  getUnrewardedCompletedDailyChallenges,
  mutateGlobalState,
  resumeDailyChallengeReward,
  resumeWeeklyRewards,
  tryClaimWeeklyReset,
} from "./farmRepository.ts";
import type { CropId } from "../types";

// ===========================================================================
// ACTIVATION FAIL-CLOSED
// ===========================================================================
//
// Meme discipline que postgresRuntimeAllowlist.ts : lecture pure,
// testable, fail-closed. AUCUNE normalisation (pas de trim, pas de
// lowercase) -- seule la chaine EXACTE "true" active le scheduler.
// undefined/""/"false"/"0"/"yes"/"TRUE"/" true "/toute typo => desactive.
// Centralise ici pour que bot.ts n'ait qu'un seul point de lecture de
// cette variable.
export const POSTGRES_SCHEDULER_ENABLED_ENV_VAR = "FARM2WIN_POSTGRES_SCHEDULER_ENABLED";

export function isPostgresSchedulerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[POSTGRES_SCHEDULER_ENABLED_ENV_VAR] === "true";
}

// ===========================================================================
// DEPENDANCES INJECTABLES
// ===========================================================================
//
// sendReadyNotification n'a AUCUNE valeur par defaut sensee (elle depend
// d'un Client discord.js concret, qui n'existe qu'au runtime reel cote
// bot.ts) -- contrairement a toutes les autres primitives ci-dessous, deja
// completement reelles et par defaut via realPostgresSchedulerPrimitives.
// now() est injectable pour les tests (deterministe), reel par defaut via
// buildRealPostgresSchedulerDeps().
export interface ReadyPlotNotification {
  cropId: CropId;
  plotIndex: number;
}

export interface PostgresSchedulerDeps {
  mutateGlobalState: typeof mutateGlobalState;
  tryClaimWeeklyReset: typeof tryClaimWeeklyReset;
  resumeWeeklyRewards: typeof resumeWeeklyRewards;
  getPendingWeeklyCycleIds: typeof getPendingWeeklyCycleIds;
  getUnrewardedCompletedDailyChallenges: typeof getUnrewardedCompletedDailyChallenges;
  resumeDailyChallengeReward: typeof resumeDailyChallengeReward;
  getAllPlayers: typeof getAllPlayers;
  claimReadyPlotNotification: typeof claimReadyPlotNotification;
  sendReadyNotification: (playerId: string, readyPlots: ReadyPlotNotification[]) => Promise<void>;
  now: () => number;
}

export const realPostgresSchedulerPrimitives: Omit<PostgresSchedulerDeps, "sendReadyNotification" | "now"> = {
  mutateGlobalState,
  tryClaimWeeklyReset,
  resumeWeeklyRewards,
  getPendingWeeklyCycleIds,
  getUnrewardedCompletedDailyChallenges,
  resumeDailyChallengeReward,
  getAllPlayers,
  claimReadyPlotNotification,
};

/**
 * Construit les deps completes pour un tick reel : toutes les primitives
 * LOT5 deja reelles (realPostgresSchedulerPrimitives) PLUS le callback
 * d'envoi de DM fourni par l'appelant (bot.ts, qui detient le Client
 * discord.js) et `Date.now()` reel.
 */
export function buildRealPostgresSchedulerDeps(
  sendReadyNotification: PostgresSchedulerDeps["sendReadyNotification"],
): PostgresSchedulerDeps {
  return {
    ...realPostgresSchedulerPrimitives,
    sendReadyNotification,
    now: () => Date.now(),
  };
}

// ===========================================================================
// ISOLATION DES ERREURS : une etape qui echoue n'empeche jamais les
// suivantes. Loggee avec un contexte clair (nom de l'etape), JAMAIS de
// playerId ni de secret.
// ===========================================================================
async function runStep(step: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error({ err: error, step }, "[postgresScheduler] etape en echec, le tick poursuit malgre tout");
  }
}

// ===========================================================================
// SEQUENCE D'UN TICK
// ===========================================================================
//
// A. GLOBAL STATE -- meteo/marche/contrat/rotation du defi quotidien, via
//    enrichGlobalState() (../farm.ts, reutilisee telle quelle) verrouillee/
//    ecrite par mutateGlobalState() (deja concue pour recevoir exactement
//    cette fonction, voir son commentaire dans farmRepository.ts).
// B. WEEKLY (nouvelle election) -- tryClaimWeeklyReset() ; si gagnee,
//    resumeWeeklyRewards(cycleId) immediatement.
// C. WEEKLY (reprise) -- getPendingWeeklyCycleIds() ; pour chaque cycle
//    PAS DEJA repris a l'etape B DANS CE MEME TICK (evite un resume
//    redondant local, aucun etat global -- juste une variable locale a CET
//    appel de runPostgresSchedulerTick), resumeWeeklyRewards(cycleId).
//    L'idempotence reelle reste de toute facon garantie par reward_claims
//    (UNIQUE constraint), meme si cette optimisation etait absente.
// D. DAILY REWARDS -- getUnrewardedCompletedDailyChallenges() ; pour
//    chaque defi, resumeDailyChallengeReward(challenge.id).
// E. READY PLOT NOTIFICATIONS -- getAllPlayers() (deja existante, DEJA
//    utilisee par /leaderboard et /weekly ; retourne PlayerState[] avec
//    plots complets -- AUCUNE nouvelle primitive/couche repository requise
//    pour lister les joueurs/parcelles Postgres). Pour chaque joueur,
//    chaque parcelle candidate (cropId non nul, jamais encore notifiee,
//    isReady() vrai -- MEME filtre exact que notifyReadyCrops() en V1,
//    bot.ts) : readyAt calcule via la MEME formule que isReady()
//    elle-meme (farm.ts) -- plantedAt + growMinutes()*60000, aucune regle
//    dupliquee, growMinutes() reste l'unique source de la duree de pousse
//    -- puis claimReadyPlotNotification(...), qui refait sa propre
//    verification autoritaire cote DB. Les parcelles reellement
//    reclamees (claimed=true) pour un MEME joueur sont regroupees en UN
//    SEUL envoi (sendReadyNotification), pour reproduire le comportement
//    V1 (un DM par joueur listant toutes ses recoltes pretes, jamais un DM
//    par parcelle) -- AUCUN changement de contenu utilisateur. Pas de
//    filtrage allowlist ici : tout joueur present dans Postgres est deja,
//    par construction, un joueur dont les donnees Postgres font foi.
export async function runPostgresSchedulerTick(deps: PostgresSchedulerDeps): Promise<void> {
  await runStep("global-state", async () => {
    await deps.mutateGlobalState((global) => {
      enrichGlobalState(global);
    });
  });

  const resumedCycleIdsThisTick = new Set<string>();

  await runStep("weekly-election", async () => {
    const result = await deps.tryClaimWeeklyReset();
    if (result.claimed) {
      await deps.resumeWeeklyRewards(result.cycleId);
      resumedCycleIdsThisTick.add(result.cycleId);
    }
  });

  await runStep("weekly-resume-pending", async () => {
    const pendingCycleIds = await deps.getPendingWeeklyCycleIds();
    for (const cycleId of pendingCycleIds) {
      if (resumedCycleIdsThisTick.has(cycleId)) continue;
      try {
        await deps.resumeWeeklyRewards(cycleId);
        resumedCycleIdsThisTick.add(cycleId);
      } catch (error) {
        logger.error(
          { err: error, step: "weekly-resume-pending-item", cycleId },
          "[postgresScheduler] reprise d'un cycle hebdomadaire en echec -- les cycles suivants continuent",
        );
      }
    }
  });

  await runStep("daily-challenge-rewards", async () => {
    const challenges = await deps.getUnrewardedCompletedDailyChallenges();
    for (const challenge of challenges) {
      try {
        await deps.resumeDailyChallengeReward(challenge.id);
      } catch (error) {
        logger.error(
          { err: error, step: "daily-challenge-reward-item", challengeId: challenge.id },
          "[postgresScheduler] reprise d'une recompense de defi quotidien en echec -- les defis suivants continuent",
        );
      }
    }
  });

  await runStep("ready-plot-notifications", async () => {
    const players = await deps.getAllPlayers();
    const now = deps.now();
    for (const player of players) {
      const claimedPlots: ReadyPlotNotification[] = [];
      for (let plotIndex = 0; plotIndex < player.plots.length; plotIndex++) {
        const plot = player.plots[plotIndex]!;
        if (!plot.cropId || plot.notifiedReady || plot.plantedAt === null) continue;
        if (!isReady(player, plotIndex, now)) continue;
        const readyAt = plot.plantedAt + growMinutes(player, plot.cropId) * 60 * 1000;
        try {
          const { claimed } = await deps.claimReadyPlotNotification(
            player.userId,
            plotIndex,
            plot.plantedAt,
            readyAt,
            now,
          );
          if (claimed) {
            claimedPlots.push({ cropId: plot.cropId, plotIndex });
          }
        } catch (error) {
          logger.error(
            { err: error, step: "ready-plot-claim-item", plotIndex },
            "[postgresScheduler] reclamation d'une parcelle prete en echec -- les parcelles/joueurs suivants continuent",
          );
        }
      }
      if (claimedPlots.length === 0) continue;
      try {
        await deps.sendReadyNotification(player.userId, claimedPlots);
      } catch (error) {
        logger.warn(
          { err: error, step: "ready-plot-notifications" },
          "[postgresScheduler] envoi de la notification DM echoue pour un joueur -- notification perdue, aucun renvoi (deja reclamee en base)",
        );
      }
    }
  });
}

// ===========================================================================
// PROTECTION ANTI-CHEVAUCHEMENT (LOCALE AU PROCESS UNIQUEMENT)
// ===========================================================================
//
// Un booleen ferme sur une closure, rien de plus -- si un tick est encore
// en cours quand le suivant se declenche (tick precedent trop long), le
// nouveau declenchement est simplement ignore. Ne remplace PAS l'idempotence
// Postgres multi-replica (voir en-tete de fichier) : sert uniquement a
// eviter un travail redondant/chevauchant DANS UN MEME process.
export function createPostgresSchedulerTickRunner(
  deps: PostgresSchedulerDeps,
): () => Promise<void> {
  let tickRunning = false;
  return async function runTick(): Promise<void> {
    if (tickRunning) {
      logger.warn("[postgresScheduler] tick precedent encore en cours -- ce declenchement est ignore");
      return;
    }
    tickRunning = true;
    try {
      await runPostgresSchedulerTick(deps);
    } finally {
      tickRunning = false;
    }
  };
}
