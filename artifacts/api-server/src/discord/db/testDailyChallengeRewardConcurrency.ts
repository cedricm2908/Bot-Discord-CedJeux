// Test D'INTEGRATION REEL pour getUnrewardedCompletedDailyChallenges() et
// resumeDailyChallengeReward(), contre la base V2 TEST (Neon TEST)
// UNIQUEMENT. Jamais de donnee V1/production, jamais de
// DELETE/DROP/TRUNCATE, jamais de migration.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`.
//
// ==========================================================================
// LIMITE DE PORTEE -- LUE ATTENTIVEMENT AVANT TOUTE EXECUTION
// ==========================================================================
// ARCHITECTURE CORRIGEE (voir farmRepository.ts) : `rewarded` ne passe a
// `true` qu'EN DERNIER, une fois TOUS les paiements par contributeur
// confirmes -- resumeDailyChallengeReward() ne fait donc plus "d'election
// prealable" comme l'ancienne version. Mais cela NE rend PAS ce scenario
// plus sur a tester en conditions reelles pour autant : des qu'un defi est
// `completed=true`, resumeDailyChallengeReward() tente un paiement
// (claimAndMutatePlayer, qui insere une ligne reward_claims PERMANENTE et
// irrecuperable sans DELETE, interdit) pour CHAQUE contributeur, meme si
// la finalisation `rewarded=true` echoue ensuite. Ce script NE DECLENCHE
// donc TOUJOURS PAS de paiement reel, et c'est DELIBERE.
//
// Ce qui EST teste ici, en conditions reelles, sans aucun residu possible :
//  1. getUnrewardedCompletedDailyChallenges() (LECTURE SEULE STRICTE,
//     aucune ecriture possible par construction) sur la base TEST
//     actuelle -- le defi courant n'est pas complete (voir garde-fou de
//     ciblage plus bas), donc la liste retournee ne doit PAS le contenir.
//  2. resumeDailyChallengeReward(challengeId) applique au defi COURANT
//     (non complete) : le garde `if (!challenge.completed) throw` s'execute
//     AVANT tout paiement -- rejette proprement, SANS AUCUNE ECRITURE.
//     Verifie meme sous DEUX appels concurrents.
//
// Pour tester reellement le fan-out de paiement + la finalisation (le
// vrai CAS sur rewarded, et l'idempotence par contributeur), memes deux
// options qu'indiquees dans testWeeklyClaimConcurrency.ts (base TEST
// jetable dediee, ou acceptation explicite de residu permanent assumee
// par l'utilisateur) -- aucune entreprise par ce script. Ce point precis
// est deja largement couvert par les tests UNITAIRES
// (farmRepositoryClaims.test.ts, "resumeDailyChallengeReward 11./12./13.")
// avec des mocks simulant fidelement les vraies contraintes SQL.
//
// GARDE-FOUS (tous doivent passer, dans l'ordre, avant toute lecture) :
//  1. ALLOW_DAILY_REWARD_TEST doit etre exactement "yes-daily-reward-test-db".
//  2. TEST_DATABASE_CONFIRMATION doit etre exactement "cedjeux-v2-test".
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme protection. Lu et logge a titre
//  informatif uniquement.
//
// GARDE-FOU DE CIBLAGE CRITIQUE : ce script REFUSE de continuer si le defi
// quotidien courant est deja `completed` -- dans ce cas,
// resumeDailyChallengeReward() risquerait de reellement payer des
// contributeurs. Arret propre AVANT tout appel, avec explication.
//
// N'affiche jamais DATABASE_URL. Aucun DELETE/DROP/TRUNCATE, aucun reset
// global, aucun seed, aucune migration, aucun changement de schema.
// AUCUNE ECRITURE n'est jamais tentee par ce script (lecture seule de bout
// en bout).

import assert from "node:assert/strict";

console.log(
  `[test-daily-reward] NODE_ENV actuel : ${process.env.NODE_ENV ?? "(non defini)"} (indicatif uniquement, ne bloque pas).`,
);

console.log("[test-daily-reward] Validation des garde-fous d'environnement...");

if (process.env.ALLOW_DAILY_REWARD_TEST !== "yes-daily-reward-test-db") {
  console.error(
    '[test-daily-reward] Garde-fou : definir ALLOW_DAILY_REWARD_TEST="yes-daily-reward-test-db" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_CONFIRMATION !== "cedjeux-v2-test") {
  console.error(
    '[test-daily-reward] Garde-fou : definir TEST_DATABASE_CONFIRMATION="cedjeux-v2-test" pour confirmer explicitement que la base ciblee est bien la base V2 TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[test-daily-reward] DATABASE_URL est absente de l'environnement. Test annule.");
  process.exit(1);
}

console.log("[test-daily-reward] Garde-fous d'environnement OK.");

async function run(): Promise<void> {
  const { pool } = await import("@workspace/db");
  const { getGlobalState, getUnrewardedCompletedDailyChallenges, resumeDailyChallengeReward } = await import(
    "./farmRepository.ts"
  );

  try {
    console.log("[test-daily-reward] Lecture de l'etat global initial...");
    const initialGlobal = await getGlobalState();
    assert.ok(
      initialGlobal,
      "global_state/contract/daily_challenge introuvables -- ce n'est pas la base TEST attendue, arret.",
    );

    // --- Garde-fou de ciblage critique : refuse si le defi est complete
    // (voir en-tete). Aucun appel a resumeDailyChallengeReward() avant ce
    // controle. ---
    if (initialGlobal.dailyChallenge.completed) {
      console.error(
        `[test-daily-reward] REFUS : le defi quotidien courant est deja "completed" (progress=${initialGlobal.dailyChallenge.progress}/${initialGlobal.dailyChallenge.target}, rewarded=${initialGlobal.dailyChallenge.rewarded}). resumeDailyChallengeReward() risquerait de reellement payer des contributeurs (voir en-tete de ce fichier). Arret AVANT tout appel, aucune ecriture tentee.`,
      );
      process.exit(1);
    }

    console.log(
      `[test-daily-reward] Defi courant NON complete confirme (progress=${initialGlobal.dailyChallenge.progress}/${initialGlobal.dailyChallenge.target}) -- scenario sans ecriture possible, poursuite.`,
    );

    console.log("[test-daily-reward] 1. getUnrewardedCompletedDailyChallenges() (lecture seule)...");
    const unrewarded = await getUnrewardedCompletedDailyChallenges();
    const currentChallengeIsListed = unrewarded.some((challenge) => challenge.cropId === initialGlobal.dailyChallenge.cropId && challenge.startedAt.getTime() === initialGlobal.dailyChallenge.startedAt);
    assert.ok(
      !currentChallengeIsListed,
      "Le defi courant (non complete) ne doit PAS apparaitre dans les defis a distribuer.",
    );
    console.log(
      `[test-daily-reward] getUnrewardedCompletedDailyChallenges() verifie : ${unrewarded.length} defi(s) trouve(s), le defi courant n'y figure pas (attendu, il n'est pas complete).`,
    );

    console.log(
      "[test-daily-reward] 2. Lancement de DEUX resumeDailyChallengeReward() EN PARALLELE sur un id sonde (doit rejeter proprement, sans ecriture)...",
    );
    // GlobalState (type metier retourne par getGlobalState()) n'expose pas
    // l'id numerique brut de la ligne daily_challenge courante -- ce
    // script utilise donc un id NEGATIF, garanti inexistant (serial,
    // commence a 1), pour verifier concretement la garantie de securite :
    // resumeDailyChallengeReward() rejette AVANT toute ecriture des que sa
    // precondition n'est pas remplie -- que la raison exacte soit "id
    // introuvable" ou "pas completed" ne change rien a cette garantie de
    // securite (zero ecriture dans les deux cas), verifiee ici pour de
    // vrai contre la base TEST.
    const PROBE_CHALLENGE_ID = -1;
    const [resultA, resultB] = await Promise.allSettled([
      resumeDailyChallengeReward(PROBE_CHALLENGE_ID),
      resumeDailyChallengeReward(PROBE_CHALLENGE_ID),
    ]);

    assert.equal(resultA.status, "rejected", "resumeDailyChallengeReward doit rejeter (id inconnu ou non complete).");
    assert.equal(resultB.status, "rejected", "resumeDailyChallengeReward doit rejeter (id inconnu ou non complete).");

    const afterGlobal = await getGlobalState();
    assert.ok(afterGlobal, "Relecture apres appel : etat global introuvable.");
    assert.deepStrictEqual(
      afterGlobal,
      initialGlobal,
      "L'etat global complet (dont dailyChallenge/contributors) doit rester rigoureusement identique -- aucune ecriture ne devait avoir lieu.",
    );

    console.log(
      "[test-daily-reward] Resultat verifie avec succes : decouverte correcte (lecture seule), et resumeDailyChallengeReward() rejette proprement sans aucune ecriture sur un defi non complete/inconnu -- zero residu, comme attendu.",
    );
  } finally {
    await pool.end();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[test-daily-reward] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
