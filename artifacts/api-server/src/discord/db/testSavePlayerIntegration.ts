// Test D'INTEGRATION CONTROLE pour savePlayer(), contre la base V2 TEST
// (Neon TEST) UNIQUEMENT. Modifie puis restaure immediatement une seule
// valeur anodine (coins) sur le joueur de test connu -- jamais de donnee
// V1/production, jamais de DELETE, jamais de migration.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`.
//
// GARDE-FOUS (tous doivent passer, dans l'ordre, avant toute lecture/ecriture) :
//  1. ALLOW_SAVEPLAYER_INTEGRATION_TEST doit etre exactement
//     "yes-saveplayer-test-db".
//  2. TEST_DATABASE_CONFIRMATION doit etre exactement "cedjeux-v2-test".
//     (memes deux variables dediees que seedTest.ts, opt-in explicite et
//     volontaire, distinctes de DATABASE_URL.)
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme protection (Railway le fixe a
//  "production" sur tous ses services, y compris celui de test -- voir
//  seedTest.ts pour le meme raisonnement). Lu et logge a titre informatif
//  uniquement.
//
// GARDE-FOUS DE CIBLAGE (avant toute ecriture, en plus des variables
// ci-dessus) : joueur "v2-test-player-001" present, userId correspondant,
// EXACTEMENT 1 joueur au total, EXACTEMENT 4 parcelles, EXACTEMENT 2
// entrees d'inventaire, coins == 50. Si l'un de ces controles echoue, le
// script s'arrete avant toute ecriture -- ce n'est pas la base TEST connue.
//
// ROBUSTESSE DE LA RESTAURATION (try/finally) : la modification et sa
// verification vivent dans un bloc `try`, la restauration vit dans le
// `finally` correspondant -- un `finally` s'execute TOUJOURS, que le `try`
// se termine normalement ou par une exception (ex. la verification
// coins==51 echoue). Ca garantit que la restauration est tentee des que
// l'etat initial a ete lu avec succes, peu importe ce qui echoue ensuite.
// Les erreurs de la phase de modification et celles de la phase de
// restauration sont capturees SEPAREMENT (jamais l'une n'ecrase l'autre)
// et rapportees ensemble a la fin -- si l'une ou l'autre a echoue, le
// script sort avec le code 1.
//
// N'affiche jamais DATABASE_URL. Aucun DELETE, aucune migration, aucun
// changement de schema.

import assert from "node:assert/strict";
import type { PlayerState } from "../types";

const TEST_PLAYER_ID = "v2-test-player-001";
const EXPECTED_PLOT_COUNT = 4;
const EXPECTED_INVENTORY_ENTRY_COUNT = 2;
const EXPECTED_INITIAL_COINS = 50;
const MODIFIED_COINS = 51;

console.log(`[test-save-player] NODE_ENV actuel : ${process.env.NODE_ENV ?? "(non defini)"} (indicatif uniquement, ne bloque pas).`);

if (process.env.ALLOW_SAVEPLAYER_INTEGRATION_TEST !== "yes-saveplayer-test-db") {
  console.error(
    '[test-save-player] Garde-fou : definir ALLOW_SAVEPLAYER_INTEGRATION_TEST="yes-saveplayer-test-db" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_CONFIRMATION !== "cedjeux-v2-test") {
  console.error(
    '[test-save-player] Garde-fou : definir TEST_DATABASE_CONFIRMATION="cedjeux-v2-test" pour confirmer explicitement que la base ciblee est bien la base V2 TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[test-save-player] DATABASE_URL est absente de l'environnement. Test annule.");
  process.exit(1);
}

async function run(): Promise<void> {
  const { pool } = await import("@workspace/db");
  const { getPlayer, getAllPlayers, savePlayer } = await import("./farmRepository.ts");

  try {
    console.log("[test-save-player] Lecture de l'etat initial du joueur de test...");
    const initialState = await getPlayer(TEST_PLAYER_ID);

    // --- Garde-fous de ciblage : rien n'est ecrit avant que TOUS passent ---
    assert.ok(
      initialState,
      `Joueur "${TEST_PLAYER_ID}" absent -- ce n'est pas la base TEST attendue, arret sans ecriture.`,
    );
    assert.equal(
      initialState.userId,
      TEST_PLAYER_ID,
      `userId inattendu ("${initialState.userId}") -- arret sans ecriture.`,
    );
    const allPlayers = await getAllPlayers();
    assert.equal(
      allPlayers.length,
      1,
      `Nombre de joueurs attendu=1, trouve=${allPlayers.length} -- ce n'est pas la base TEST attendue, arret sans ecriture.`,
    );
    assert.equal(
      initialState.plots.length,
      EXPECTED_PLOT_COUNT,
      `${EXPECTED_PLOT_COUNT} parcelles attendues, trouve ${initialState.plots.length} -- arret sans ecriture.`,
    );
    assert.equal(
      Object.keys(initialState.inventory).length,
      EXPECTED_INVENTORY_ENTRY_COUNT,
      `${EXPECTED_INVENTORY_ENTRY_COUNT} entrees d'inventaire attendues, trouve ${Object.keys(initialState.inventory).length} -- arret sans ecriture.`,
    );
    assert.equal(
      initialState.coins,
      EXPECTED_INITIAL_COINS,
      `coins=${EXPECTED_INITIAL_COINS} attendu au depart, trouve ${initialState.coins} -- arret sans ecriture.`,
    );
    console.log("[test-save-player] Garde-fous de ciblage OK -- base TEST confirmee, poursuite.");

    // --- Modification + restauration : la restauration (finally) s'execute
    // TOUJOURS, meme si la verification apres modification echoue. Les
    // erreurs des deux phases sont capturees separement, jamais l'une
    // n'ecrase l'autre. ---
    const errors: string[] = [];

    try {
      console.log(`[test-save-player] Modification : coins ${EXPECTED_INITIAL_COINS} -> ${MODIFIED_COINS}...`);
      const modifiedState: PlayerState = { ...initialState, coins: MODIFIED_COINS };
      await savePlayer(modifiedState);

      const afterModify = await getPlayer(TEST_PLAYER_ID);
      assert.ok(afterModify, "Relecture apres modification : joueur introuvable.");
      assert.deepStrictEqual(
        afterModify,
        { ...initialState, coins: MODIFIED_COINS },
        "Etat apres modification ne correspond pas exactement a l'attendu (coins modifie, reste identique).",
      );
      console.log(`[test-save-player] Modification verifiee avec succes (coins=${MODIFIED_COINS}, reste identique).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Phase modification : ${message}`);
      console.error(`[test-save-player] ECHEC phase modification : ${message}`);
    } finally {
      console.log("[test-save-player] Restauration de l'etat initial (tentee dans tous les cas)...");
      try {
        await savePlayer(initialState);
        const afterRestore = await getPlayer(TEST_PLAYER_ID);
        assert.ok(afterRestore, "Relecture apres restauration : joueur introuvable.");
        assert.deepStrictEqual(
          afterRestore,
          initialState,
          "Etat apres restauration ne correspond pas exactement a l'etat initial.",
        );
        console.log("[test-save-player] Restauration verifiee avec succes (etat initial retrouve a l'identique).");
      } catch (restoreError) {
        const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
        errors.push(
          `ECHEC DE LA RESTAURATION : ${message} -- le joueur de test peut etre dans un etat modifie, verification manuelle necessaire.`,
        );
        console.error(`[test-save-player] ${errors[errors.length - 1]}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`${errors.length} verification(s) en echec :\n- ${errors.join("\n- ")}`);
    }

    console.log("[test-save-player] Test d'integration reussi de bout en bout -- etat TEST restaure a l'identique.");
  } finally {
    await pool.end();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[test-save-player] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
