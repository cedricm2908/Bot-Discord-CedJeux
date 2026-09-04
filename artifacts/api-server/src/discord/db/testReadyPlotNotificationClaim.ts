// Test D'INTEGRATION REEL pour claimReadyPlotNotification(), contre la
// base V2 TEST (Neon TEST) UNIQUEMENT. Jamais de donnee V1/production,
// jamais de DELETE/DROP/TRUNCATE, jamais de migration.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`.
//
// CONTRAIREMENT aux scripts weekly/daily-challenge de ce lot, ce test PEUT
// exercer reellement le scenario "claim gagne" : claimReadyPlotNotification()
// n'ecrit QUE `plots.notified_ready` (une colonne ordinaire, PAS une table
// append-only comme reward_claims) -- entierement restaurable via
// mutatePlayer(), sans DELETE, sans residu permanent possible. C'est pour
// cela que ce script, seul des trois de ce lot, teste la VRAIE
// serialisation concurrente de bout en bout.
//
// SCENARIO : le joueur TEST cible n'a par defaut aucune parcelle plantee
// (etat seede). Ce script PLANTE temporairement une culture controlee sur
// une parcelle (mutation directe des champs plot -- PAS via plant(), pour
// ne toucher ni coins ni quetes), avec un `plantedAt` deliberement tres
// ancien pour etre immediatement "pret" sans avoir besoin de reproduire la
// formule growMinutes() (readyAt = plantedAt, largement suffisant), lance
// DEUX claimReadyPlotNotification() concurrents sur cette MEME parcelle,
// verifie qu'un seul gagne, PUIS restaure la parcelle a son etat initial
// exact (vide) dans un `finally`.
//
// GARDE-FOUS (tous doivent passer, dans l'ordre, avant toute lecture/ecriture) :
//  1. ALLOW_READY_PLOT_CLAIM_TEST doit etre exactement
//     "yes-ready-plot-test-db".
//  2. TEST_DATABASE_CONFIRMATION doit etre exactement "cedjeux-v2-test".
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme protection. Lu et logge a titre
//  informatif uniquement.
//
// JOUEUR CIBLE -- FIXE, PAS DERIVE DYNAMIQUEMENT : "v2-test-player-001"
// exactement (meme principe que les scripts du LOT 4 -- jamais un ID
// arbitraire). Garde-fou de ciblage supplementaire : exactement 2 joueurs
// doivent etre presents en base ("v2-test-player-001",
// "v2-test-player-002"), confirmant qu'il s'agit bien de la base TEST
// connue, avant toute ecriture.
//
// GARDE-FOU DE CIBLAGE CRITIQUE SUR LA PARCELLE : la parcelle ciblee
// (index 0) doit etre VIDE (cropId=null) avant toute ecriture -- sinon
// arret propre (une parcelle deja plantee n'est pas l'etat TEST attendu,
// et ecraser son contenu romprait la reversibilite).
//
// ROBUSTESSE DE LA RESTAURATION (try/finally) : la phase de plantation +
// concurrence + verification vit dans un bloc `try`, la restauration de la
// parcelle a son etat initial (vide) vit dans le `finally` correspondant
// -- toujours tentee.
//
// N'affiche jamais DATABASE_URL. Aucun DELETE/DROP/TRUNCATE, aucun reset
// global, aucun seed, aucune migration, aucun changement de schema.

import assert from "node:assert/strict";
import type { PlayerState } from "../types";

const TARGET_PLAYER_ID = "v2-test-player-001";
const OTHER_EXPECTED_PLAYER_ID = "v2-test-player-002";
const TARGET_PLOT_INDEX = 0;
// Tres loin dans le passe : garantit "pret" sans avoir a reproduire
// growMinutes() (qui depend de player.irrigationLevel et du type de
// culture, volontairement hors du perimetre DB -- voir farmRepository.ts).
const SYNTHETIC_PLANTED_AT = Date.now() - 365 * 24 * 60 * 60 * 1000;
const SYNTHETIC_READY_AT = SYNTHETIC_PLANTED_AT;

// Meme logique que les scripts precedents : exclut uniquement updatedAt
// (qui avance legitimement des que mutatePlayer() ecrit le joueur, y
// compris pour la plantation/restauration controlee de ce script) de la
// comparaison stricte.
function assertPlayerStateMatchesExceptUpdatedAt(
  actual: PlayerState | null,
  expected: PlayerState,
  context: string,
): void {
  assert.ok(actual, `${context} : joueur introuvable.`);
  const { updatedAt: _actualUpdatedAt, ...actualRest } = actual;
  const { updatedAt: _expectedUpdatedAt, ...expectedRest } = expected;
  assert.deepStrictEqual(actualRest, expectedRest, `${context} : champs joueur (hors updatedAt) different de l'attendu.`);
}

console.log(
  `[test-ready-plot-claim] NODE_ENV actuel : ${process.env.NODE_ENV ?? "(non defini)"} (indicatif uniquement, ne bloque pas).`,
);

console.log("[test-ready-plot-claim] Validation des garde-fous d'environnement...");

if (process.env.ALLOW_READY_PLOT_CLAIM_TEST !== "yes-ready-plot-test-db") {
  console.error(
    '[test-ready-plot-claim] Garde-fou : definir ALLOW_READY_PLOT_CLAIM_TEST="yes-ready-plot-test-db" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_CONFIRMATION !== "cedjeux-v2-test") {
  console.error(
    '[test-ready-plot-claim] Garde-fou : definir TEST_DATABASE_CONFIRMATION="cedjeux-v2-test" pour confirmer explicitement que la base ciblee est bien la base V2 TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[test-ready-plot-claim] DATABASE_URL est absente de l'environnement. Test annule.");
  process.exit(1);
}

console.log("[test-ready-plot-claim] Garde-fous d'environnement OK.");

async function run(): Promise<void> {
  const { pool } = await import("@workspace/db");
  const { getAllPlayers, getPlayer, mutatePlayer, claimReadyPlotNotification } = await import("./farmRepository.ts");

  try {
    console.log("[test-ready-plot-claim] Lecture de l'etat initial (joueurs presents + joueur cible)...");
    const allPlayers = await getAllPlayers();
    const foundIds = allPlayers.map((p) => p.userId).sort();
    const expectedIds = [TARGET_PLAYER_ID, OTHER_EXPECTED_PLAYER_ID].sort();
    const idsMatchExactly =
      foundIds.length === expectedIds.length && foundIds.every((id, index) => id === expectedIds[index]);
    if (!idsMatchExactly) {
      console.error(
        `[test-ready-plot-claim] CONDITION MANQUANTE : ce test exige EXACTEMENT les joueurs [${expectedIds.join(", ")}], mais [${foundIds.join(", ") || "(aucun)"}] trouve(s). Aucune ecriture tentee.`,
      );
      process.exit(1);
    }

    const initialPlayer = await getPlayer(TARGET_PLAYER_ID);
    assert.ok(initialPlayer, `Joueur "${TARGET_PLAYER_ID}" introuvable a la relecture -- arret sans ecriture.`);
    const initialPlot = initialPlayer.plots[TARGET_PLOT_INDEX];
    assert.ok(initialPlot, `Parcelle ${TARGET_PLOT_INDEX} introuvable -- arret sans ecriture.`);
    assert.equal(
      initialPlot.cropId,
      null,
      `Parcelle ${TARGET_PLOT_INDEX} attendue vide (cropId=null), trouvee "${initialPlot.cropId}" -- ce n'est pas l'etat TEST attendu, arret sans ecriture.`,
    );
    console.log(
      `[test-ready-plot-claim] Garde-fous de ciblage OK -- joueurs confirmes, parcelle ${TARGET_PLOT_INDEX} vide comme attendu.`,
    );

    const errors: string[] = [];

    try {
      console.log(
        `[test-ready-plot-claim] Plantation CONTROLEE (mutation directe, pas via plant()) sur la parcelle ${TARGET_PLOT_INDEX}...`,
      );
      await mutatePlayer(TARGET_PLAYER_ID, (player) => {
        player.plots[TARGET_PLOT_INDEX] = {
          cropId: "wheat",
          plantedAt: SYNTHETIC_PLANTED_AT,
          notifiedReady: false,
        };
      });

      console.log(
        "[test-ready-plot-claim] Lancement de DEUX claimReadyPlotNotification() EN PARALLELE sur la MEME parcelle...",
      );
      const [claimA, claimB] = await Promise.all([
        claimReadyPlotNotification(TARGET_PLAYER_ID, TARGET_PLOT_INDEX, SYNTHETIC_PLANTED_AT, SYNTHETIC_READY_AT),
        claimReadyPlotNotification(TARGET_PLAYER_ID, TARGET_PLOT_INDEX, SYNTHETIC_PLANTED_AT, SYNTHETIC_READY_AT),
      ]);

      const claimedCount = [claimA, claimB].filter((c) => c.claimed).length;
      assert.equal(
        claimedCount,
        1,
        `Exactement UN des deux appels concurrents doit gagner le claim (trouve ${claimedCount}) -- jamais 0 (perte), jamais 2 (double notification).`,
      );

      const afterClaim = await getPlayer(TARGET_PLAYER_ID);
      assert.ok(afterClaim, "Relecture apres claim : joueur introuvable.");
      assert.equal(
        afterClaim.plots[TARGET_PLOT_INDEX]?.notifiedReady,
        true,
        "notifiedReady doit etre passe a true suite au claim gagnant.",
      );

      console.log(
        "[test-ready-plot-claim] Resultat verifie avec succes : un seul gagnant sur deux appels concurrents, notifiedReady correctement passe a true, aucune double notification possible.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Phase de test : ${message}`);
      console.error(`[test-ready-plot-claim] ECHEC phase de test : ${message}`);
    } finally {
      console.log(`[test-ready-plot-claim] Restauration de la parcelle ${TARGET_PLOT_INDEX} a son etat initial (vide, tentee dans tous les cas)...`);
      try {
        await mutatePlayer(TARGET_PLAYER_ID, (player) => {
          player.plots[TARGET_PLOT_INDEX] = { cropId: null, plantedAt: null, notifiedReady: false };
        });
        const restoredPlayer = await getPlayer(TARGET_PLAYER_ID);
        assertPlayerStateMatchesExceptUpdatedAt(restoredPlayer, initialPlayer, "Apres restauration");
        console.log(
          "[test-ready-plot-claim] Restauration verifiee avec succes : joueur strictement identique a l'etat initial (hors updatedAt) -- aucune donnee residuelle.",
        );
      } catch (restoreError) {
        const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
        errors.push(
          `ECHEC DE LA RESTAURATION : ${message} -- le joueur TEST peut etre dans un etat modifie, verification manuelle necessaire.`,
        );
        console.error(`[test-ready-plot-claim] ${errors[errors.length - 1]}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`${errors.length} verification(s) en echec :\n- ${errors.join("\n- ")}`);
    }

    console.log(
      "[test-ready-plot-claim] Test de concurrence reussi de bout en bout -- parcelle restauree a l'identique, aucune donnee residuelle.",
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
    console.error("[test-ready-plot-claim] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
