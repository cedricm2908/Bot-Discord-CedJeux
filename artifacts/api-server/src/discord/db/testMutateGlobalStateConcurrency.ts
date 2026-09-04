// Test D'INTEGRATION REEL DE CONCURRENCE pour mutateGlobalState(), contre la
// base V2 TEST (Neon TEST) UNIQUEMENT. Lance deux mutations concurrentes
// (-1 sur contract.remaining chacune) EN PARALLELE, verifie qu'elles se
// serialisent correctement (aucun lost update), puis restaure immediatement
// l'etat initial -- jamais de donnee V1/production, jamais de
// DELETE/DROP/TRUNCATE, jamais de migration.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`.
//
// SCENARIO CHOISI : contract.remaining, decremente de 1 par chaque appel.
// C'est le champ le plus adapte a un test de concurrence "+1/-1 simple"
// apres lecture du schema reel (lib/db/src/schema/*.ts) :
//  - global_state.marketMultiplier/weatherMultiplier sont bornes par des
//    formules/CHECK non triviales (pas un simple compteur) ;
//  - global_state.weeklyStartedAt/nextWeatherAt sont des timestamps, pas
//    des compteurs -- un "+1 ms" n'a aucun sens metier observable ;
//  - contract.remaining est un ENTIER borne par des CHECK simples
//    (remaining >= 0, remaining <= required, voir contract.ts), deja
//    decremente aujourd'hui par sell() (categorie E de l'audit de
//    migration, pas encore branchee) -- ce test rejoue exactement le meme
//    type d'operation (un decrement) sur le meme champ, sans inventer de
//    nouvelle regle metier ni la modifier.
// Garde-fou specifique : le test exige remaining >= 2 AVANT toute ecriture
// (deux decrements de 1 doivent rester >= 0, sous peine de violer le CHECK
// contract_remaining_non_negative cote Postgres) -- si ce n'est pas le cas,
// le script s'arrete sans ecrire, comme les autres garde-fous de ciblage.
//
// GARDE-FOUS (tous doivent passer, dans l'ordre, avant toute lecture/ecriture) :
//  1. ALLOW_MUTATEGLOBAL_CONCURRENCY_TEST doit etre exactement
//     "yes-mutateglobal-test-db".
//  2. TEST_DATABASE_CONFIRMATION doit etre exactement "cedjeux-v2-test".
//     (memes deux variables dediees que les scripts precedents, opt-in
//     explicite et volontaire, distinctes de DATABASE_URL.)
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme protection (Railway le fixe a
//  "production" sur tous ses services, y compris celui de test -- meme
//  raisonnement que les scripts precedents). Lu et logge a titre informatif
//  uniquement.
//
// GARDE-FOUS DE CIBLAGE (avant toute ecriture, en plus des variables
// ci-dessus) : exactement 1 joueur au total, id "v2-test-player-001",
// global_state id=1 present, contract id=1 present, daily_challenge courant
// present, contract.remaining >= 2. Si l'un de ces controles echoue, le
// script s'arrete avant toute ecriture -- ce n'est pas la base TEST connue
// ou l'etat ne permet pas ce scenario en toute securite.
//
// CONCURRENCE REELLE (le point de ce test) : les deux mutateGlobalState()
// sont lances via Promise.all -- JAMAIS sequentiellement. Chacun ouvre sa
// PROPRE transaction et verrouille (SELECT ... FOR UPDATE) la meme ligne
// global_state (id=1, verrouillee EN PREMIER par mutateGlobalState) ;
// Postgres les serialise physiquement au niveau de cette ligne. Resultat
// attendu : contract.remaining = initial - 2 (jamais initial - 1 -- ce qui
// signifierait qu'un decrement a ete perdu).
//
// ROBUSTESSE DE LA RESTAURATION (try/finally) : la phase de concurrence et
// sa verification vivent dans un bloc `try`, la restauration vit dans le
// `finally` correspondant -- un `finally` s'execute TOUJOURS. Les erreurs
// des deux phases sont capturees SEPAREMENT et rapportees ensemble a la
// fin -- si l'une ou l'autre a echoue, le script sort avec le code 1.
//
// N'affiche jamais DATABASE_URL. Aucun DELETE/DROP/TRUNCATE, aucun reset
// global, aucun seed, aucune migration, aucun changement de schema.

import assert from "node:assert/strict";
import type { GlobalState } from "../types";

const TEST_PLAYER_ID = "v2-test-player-001";
const MIN_REMAINING_FOR_TEST = 2;

// mutateGlobalState()/enrichGlobalState() n'ecrivent aucun timestamp
// technique "updatedAt" (global_state n'a pas cette colonne, contrairement
// a players -- voir farmRepository.ts). La comparaison "tout sauf le champ
// sous test" peut donc etre une egalite stricte simple, sans la logique
// d'exclusion/verification separee necessaire pour updatedAt cote joueur
// (voir testSavePlayerIntegration.ts / testMutatePlayerConcurrency.ts).
function assertGlobalStateMatchesExceptContractRemaining(
  actual: GlobalState,
  expectedExceptRemaining: GlobalState,
  context: string,
): void {
  const { contract: actualContract, ...actualRest } = actual;
  const { contract: expectedContract, ...expectedRest } = expectedExceptRemaining;
  const { remaining: _actualRemaining, ...actualContractRest } = actualContract;
  const { remaining: _expectedRemaining, ...expectedContractRest } = expectedContract;

  assert.deepStrictEqual(
    actualRest,
    expectedRest,
    `${context} : les champs hors contract different de l'attendu.`,
  );
  assert.deepStrictEqual(
    actualContractRest,
    expectedContractRest,
    `${context} : les champs du contrat hors remaining different de l'attendu.`,
  );
}

console.log(
  `[test-mutate-global-concurrency] NODE_ENV actuel : ${process.env.NODE_ENV ?? "(non defini)"} (indicatif uniquement, ne bloque pas).`,
);

console.log("[test-mutate-global-concurrency] Validation des garde-fous d'environnement...");

if (process.env.ALLOW_MUTATEGLOBAL_CONCURRENCY_TEST !== "yes-mutateglobal-test-db") {
  console.error(
    '[test-mutate-global-concurrency] Garde-fou : definir ALLOW_MUTATEGLOBAL_CONCURRENCY_TEST="yes-mutateglobal-test-db" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_CONFIRMATION !== "cedjeux-v2-test") {
  console.error(
    '[test-mutate-global-concurrency] Garde-fou : definir TEST_DATABASE_CONFIRMATION="cedjeux-v2-test" pour confirmer explicitement que la base ciblee est bien la base V2 TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[test-mutate-global-concurrency] DATABASE_URL est absente de l'environnement. Test annule.");
  process.exit(1);
}

console.log("[test-mutate-global-concurrency] Garde-fous d'environnement OK.");

async function run(): Promise<void> {
  const { pool } = await import("@workspace/db");
  const { getPlayer, getAllPlayers, getGlobalState, mutateGlobalState } = await import("./farmRepository.ts");

  try {
    console.log("[test-mutate-global-concurrency] Lecture de l'etat initial (joueur de ciblage + etat global)...");
    const player = await getPlayer(TEST_PLAYER_ID);
    const initialGlobal = await getGlobalState();

    // --- Garde-fous de ciblage : rien n'est ecrit avant que TOUS passent ---
    assert.ok(
      player,
      `Joueur "${TEST_PLAYER_ID}" absent -- ce n'est pas la base TEST attendue, arret sans ecriture.`,
    );
    const allPlayers = await getAllPlayers();
    assert.equal(
      allPlayers.length,
      1,
      `Nombre de joueurs attendu=1, trouve=${allPlayers.length} -- ce n'est pas la base TEST attendue, arret sans ecriture.`,
    );
    assert.ok(
      initialGlobal,
      "global_state/contract/daily_challenge introuvables -- ce n'est pas la base TEST attendue, arret sans ecriture.",
    );
    assert.ok(
      initialGlobal.contract.remaining >= MIN_REMAINING_FOR_TEST,
      `contract.remaining=${initialGlobal.contract.remaining} insuffisant pour ce scenario (>= ${MIN_REMAINING_FOR_TEST} requis pour deux decrements sans violer contract_remaining_non_negative) -- arret sans ecriture.`,
    );
    console.log(
      `[test-mutate-global-concurrency] Garde-fous de ciblage OK -- base TEST confirmee, contract.remaining initial=${initialGlobal.contract.remaining}.`,
    );

    // --- Concurrence + restauration : la restauration (finally) s'execute
    // TOUJOURS, meme si la verification apres concurrence echoue. Les
    // erreurs des deux phases sont capturees separement, jamais l'une
    // n'ecrase l'autre. ---
    const errors: string[] = [];

    try {
      console.log(
        `[test-mutate-global-concurrency] Lancement de DEUX mutateGlobalState() EN PARALLELE (-1 sur contract.remaining chacune, depart=${initialGlobal.contract.remaining})...`,
      );

      // Promise.all : les deux mutations sont demarrees ensemble, jamais
      // l'une apres l'autre -- exerce reellement la serialisation par
      // SELECT ... FOR UPDATE sur global_state a l'interieur de
      // mutateGlobalState(), pas juste une execution sequentielle.
      await Promise.all([
        mutateGlobalState((global) => {
          global.contract.remaining -= 1;
        }),
        mutateGlobalState((global) => {
          global.contract.remaining -= 1;
        }),
      ]);

      console.log("[test-mutate-global-concurrency] Les deux mutations concurrentes se sont terminees sans exception.");

      const afterConcurrency = await getGlobalState();
      assert.ok(afterConcurrency, "Relecture apres concurrence : etat global introuvable.");
      const expectedRemaining = initialGlobal.contract.remaining - 2;
      assert.equal(
        afterConcurrency.contract.remaining,
        expectedRemaining,
        `contract.remaining=${afterConcurrency.contract.remaining} attendu=${expectedRemaining} (jamais -1 seulement -- ce qui signifierait un decrement perdu).`,
      );
      assertGlobalStateMatchesExceptContractRemaining(
        afterConcurrency,
        initialGlobal,
        "Apres les deux mutations concurrentes",
      );
      console.log(
        `[test-mutate-global-concurrency] Resultat verifie avec succes : contract.remaining=${expectedRemaining} (jamais ${initialGlobal.contract.remaining - 1} -- aucun lost update), tous les autres champs identiques.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Phase de concurrence : ${message}`);
      console.error(`[test-mutate-global-concurrency] ECHEC phase de concurrence : ${message}`);
    } finally {
      console.log("[test-mutate-global-concurrency] Restauration de l'etat initial (tentee dans tous les cas)...");
      try {
        await mutateGlobalState((global) => {
          global.contract.remaining = initialGlobal.contract.remaining;
        });
        const afterRestore = await getGlobalState();
        assert.ok(afterRestore, "Relecture apres restauration : etat global introuvable.");
        assert.equal(afterRestore.contract.remaining, initialGlobal.contract.remaining);
        assertGlobalStateMatchesExceptContractRemaining(afterRestore, initialGlobal, "Apres restauration");
        console.log("[test-mutate-global-concurrency] Restauration verifiee avec succes (etat initial retrouve a l'identique).");
      } catch (restoreError) {
        const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
        errors.push(
          `ECHEC DE LA RESTAURATION : ${message} -- l'etat global TEST peut etre modifie, verification manuelle necessaire.`,
        );
        console.error(`[test-mutate-global-concurrency] ${errors[errors.length - 1]}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`${errors.length} verification(s) en echec :\n- ${errors.join("\n- ")}`);
    }

    console.log(
      "[test-mutate-global-concurrency] Test de concurrence reussi de bout en bout -- etat TEST restaure a l'identique.",
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
    console.error("[test-mutate-global-concurrency] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
