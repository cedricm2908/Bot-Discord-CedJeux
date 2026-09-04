// Test D'INTEGRATION REEL pour tryClaimWeeklyReset(), contre la base V2
// TEST (Neon TEST) UNIQUEMENT. Jamais de donnee V1/production, jamais de
// DELETE/DROP/TRUNCATE, jamais de migration.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`.
//
// ==========================================================================
// LIMITE DE PORTEE -- LUE ATTENTIVEMENT AVANT TOUTE EXECUTION
// ==========================================================================
// Ce script NE TESTE PAS le scenario "election reellement gagnee" en
// conditions reelles, et c'est DELIBERE.
//
// Pourquoi : tryClaimWeeklyReset(), quand il gagne l'election, INSERE des
// lignes reward_claims (claim_type "weekly-bonus-assignment:<cycleId>:
// rank<N>") -- c'est PRECISEMENT ce qui garantit l'idempotence (voir
// farmRepository.ts). Cette table n'a AUCUN mecanisme de restauration :
// DELETE est interdit dans ce projet, et reward_claims est concue pour
// etre un journal permanent. Forcer une election reelle ici (meme en
// avancant artificiellement weekly_started_at puis en le restaurant apres
// coup -- ce qui EST possible via mutateGlobalState) laisserait TROIS
// lignes reward_claims PERMANENTES et irrecuperables en base TEST. La
// consigne de cette etape est explicite : "NE LANCE PAS / NE CONCOIS PAS
// un test qui pollue la base" -- ce script s'y conforme en NE DECLENCHANT
// JAMAIS une election reelle.
//
// Ce qui EST teste ici, en conditions reelles, sans aucun residu possible :
// le cas SUR ET UNIVERSEL "le cycle hebdomadaire n'est PAS du" (vrai des
// que weekly_started_at est recent, ce qui est le cas de la base TEST
// actuelle, seedee/utilisee il y a moins de 7 jours) -- deux appels
// CONCURRENTS a tryClaimWeeklyReset() doivent tous les deux retourner
// { claimed: false } SANS AUCUNE ECRITURE, prouvant qu'aucun faux positif
// ne se produit meme sous appel concurrent reel.
//
// Pour tester reellement "2 claims concurrents -> 1 seul gagnant" (le
// vrai CAS sur weekly_started_at), DEUX options, aucune des deux
// entreprise par ce script :
//   (a) une base TEST JETABLE dediee (creee, testee, detruite -- DROP
//       autorise sur une base entierement disponible, jamais sur
//       cedjeux-v2-test), a mettre en place separement si souhaite ;
//   (b) accepter EXPLICITEMENT et consciemment la creation de 3 lignes
//       reward_claims permanentes dans cedjeux-v2-test comme fixture
//       durable assumee -- decision qui appartient a l'utilisateur, pas a
//       ce script.
// Ce point precis est deja largement couvert par les tests UNITAIRES
// (farmRepositoryClaims.test.ts, "tryClaimWeeklyReset 13.") avec un mock
// simulant fidelement l'atomicite de la vraie contrainte SQL.
//
// resumeWeeklyRewards() N'EST PAS APPELE NON PLUS, meme sur le cycle non
// du : contrairement a tryClaimWeeklyReset(), il n'a AUCUN garde-fou "rien
// a faire, aucune ecriture" integre -- meme avec zero gagnant, il tente un
// claim `weekly-snapshot:<cycleId>` pour CHAQUE joueur, ce qui ecrirait
// des lignes reward_claims permanentes pour un cycle jamais reellement
// elu. Seul getCurrentWeeklyCycleId() (lecture seule stricte) est exerce
// ici reellement.
//
// GARDE-FOUS (tous doivent passer, dans l'ordre, avant toute lecture) :
//  1. ALLOW_WEEKLY_CLAIM_TEST doit etre exactement "yes-weekly-claim-test-db".
//  2. TEST_DATABASE_CONFIRMATION doit etre exactement "cedjeux-v2-test".
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme protection. Lu et logge a titre
//  informatif uniquement.
//
// GARDE-FOU DE CIBLAGE CRITIQUE : ce script REFUSE de continuer si le
// cycle hebdomadaire est deja du (now - weeklyStartedAt >= 7 jours) --
// dans ce cas, l'appeler declencherait une election REELLE et gagnee,
// exactement le scenario que ce script refuse de produire. Arret propre
// AVANT tout appel a tryClaimWeeklyReset(), avec explication.
//
// N'affiche jamais DATABASE_URL. Aucun DELETE/DROP/TRUNCATE, aucun reset
// global, aucun seed, aucune migration, aucun changement de schema.
// AUCUNE ECRITURE n'est jamais tentee par ce script (lecture seule de bout
// en bout).

import assert from "node:assert/strict";

const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

console.log(
  `[test-weekly-claim] NODE_ENV actuel : ${process.env.NODE_ENV ?? "(non defini)"} (indicatif uniquement, ne bloque pas).`,
);

console.log("[test-weekly-claim] Validation des garde-fous d'environnement...");

if (process.env.ALLOW_WEEKLY_CLAIM_TEST !== "yes-weekly-claim-test-db") {
  console.error(
    '[test-weekly-claim] Garde-fou : definir ALLOW_WEEKLY_CLAIM_TEST="yes-weekly-claim-test-db" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_CONFIRMATION !== "cedjeux-v2-test") {
  console.error(
    '[test-weekly-claim] Garde-fou : definir TEST_DATABASE_CONFIRMATION="cedjeux-v2-test" pour confirmer explicitement que la base ciblee est bien la base V2 TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[test-weekly-claim] DATABASE_URL est absente de l'environnement. Test annule.");
  process.exit(1);
}

console.log("[test-weekly-claim] Garde-fous d'environnement OK.");

async function run(): Promise<void> {
  const { pool } = await import("@workspace/db");
  const { getGlobalState, getCurrentWeeklyCycleId, tryClaimWeeklyReset } = await import("./farmRepository.ts");

  try {
    console.log("[test-weekly-claim] Lecture de l'etat global initial...");
    const initialGlobal = await getGlobalState();
    assert.ok(
      initialGlobal,
      "global_state/contract/daily_challenge introuvables -- ce n'est pas la base TEST attendue, arret.",
    );

    const now = Date.now();
    const elapsed = now - initialGlobal.weeklyStartedAt;
    const isDue = elapsed >= WEEKLY_INTERVAL_MS;

    // --- Garde-fou de ciblage critique : refuse si le cycle est du (voir
    // en-tete -- une election reelle laisserait des lignes reward_claims
    // permanentes). Aucun appel a tryClaimWeeklyReset() avant ce controle. ---
    if (isDue) {
      console.error(
        `[test-weekly-claim] REFUS : le cycle hebdomadaire est actuellement DU (${elapsed}ms >= ${WEEKLY_INTERVAL_MS}ms depuis weeklyStartedAt). Appeler tryClaimWeeklyReset() declencherait une election REELLE et gagnee, inserant des lignes reward_claims permanentes (voir en-tete de ce fichier). Arret AVANT tout appel, aucune ecriture tentee.`,
      );
      process.exit(1);
    }

    console.log(
      `[test-weekly-claim] Cycle NON du confirme (${elapsed}ms < ${WEEKLY_INTERVAL_MS}ms depuis weeklyStartedAt) -- scenario sans ecriture possible, poursuite.`,
    );

    console.log("[test-weekly-claim] Lancement de DEUX tryClaimWeeklyReset() EN PARALLELE (cycle non du)...");
    const [resultA, resultB] = await Promise.all([tryClaimWeeklyReset(), tryClaimWeeklyReset()]);

    assert.equal(resultA.claimed, false, "resultA.claimed devrait etre false (cycle non du).");
    assert.equal(resultB.claimed, false, "resultB.claimed devrait etre false (cycle non du).");

    const afterGlobal = await getGlobalState();
    assert.ok(afterGlobal, "Relecture apres appel : etat global introuvable.");
    assert.equal(
      afterGlobal.weeklyStartedAt,
      initialGlobal.weeklyStartedAt,
      "weeklyStartedAt ne doit JAMAIS avoir change (cycle non du -- aucune ecriture attendue).",
    );
    assert.deepStrictEqual(
      afterGlobal,
      initialGlobal,
      "L'etat global complet doit rester rigoureusement identique -- aucune ecriture ne devait avoir lieu.",
    );

    console.log(
      "[test-weekly-claim] Resultat verifie avec succes : deux appels concurrents sur un cycle non du retournent tous deux claimed=false, AUCUNE ecriture, etat global identique bit-a-bit -- zero residu, comme attendu.",
    );

    console.log("[test-weekly-claim] Verification de getCurrentWeeklyCycleId() (lecture seule)...");
    const cycleId = await getCurrentWeeklyCycleId();
    assert.equal(
      cycleId,
      String(initialGlobal.weeklyStartedAt),
      "getCurrentWeeklyCycleId() doit refleter exactement weeklyStartedAt courant.",
    );
    console.log(`[test-weekly-claim] getCurrentWeeklyCycleId() verifie avec succes : "${cycleId}".`);
  } finally {
    await pool.end();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[test-weekly-claim] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
