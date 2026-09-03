// Test D'INTEGRATION REEL DE CONCURRENCE pour mutatePlayer(), contre la base
// V2 TEST (Neon TEST) UNIQUEMENT. Lance deux mutations concurrentes (+1 coin
// chacune) EN PARALLELE sur le meme joueur de test connu, verifie qu'elles
// se serialisent correctement (aucun lost update : 50 -> 52, jamais 51),
// puis restaure immediatement l'etat initial -- jamais de donnee
// V1/production, jamais de DELETE/DROP/TRUNCATE, jamais de migration.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`.
//
// GARDE-FOUS (tous doivent passer, dans l'ordre, avant toute lecture/ecriture) :
//  1. ALLOW_MUTATEPLAYER_CONCURRENCY_TEST doit etre exactement
//     "yes-mutateplayer-test-db".
//  2. TEST_DATABASE_CONFIRMATION doit etre exactement "cedjeux-v2-test".
//     (memes deux variables dediees que seedTest.ts/testSavePlayerIntegration.ts,
//     opt-in explicite et volontaire, distinctes de DATABASE_URL.)
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme protection (Railway le fixe a
//  "production" sur tous ses services, y compris celui de test -- meme
//  raisonnement que les scripts precedents). Lu et logge a titre informatif
//  uniquement.
//
// GARDE-FOUS DE CIBLAGE (avant toute ecriture, en plus des variables
// ci-dessus) : joueur "v2-test-player-001" present, userId correspondant,
// EXACTEMENT 1 joueur au total, EXACTEMENT 4 parcelles, EXACTEMENT 2
// entrees d'inventaire, coins == 50, level == 1. Si l'un de ces controles
// echoue, le script s'arrete avant toute ecriture -- ce n'est pas la base
// TEST connue.
//
// CONCURRENCE REELLE (le point de ce test) : les deux mutatePlayer() sont
// lances via Promise.all -- JAMAIS sequentiellement. Chacun ouvre sa PROPRE
// transaction et verrouille (SELECT ... FOR UPDATE) la meme ligne players ;
// Postgres les serialise physiquement au niveau de la ligne. Resultat
// attendu : coins=52 (jamais 51 -- 51 signifierait qu'une mutation a
// ecrase l'autre, c'est-a-dire un lost update).
//
// ROBUSTESSE DE LA RESTAURATION (try/finally) : la phase de concurrence et
// sa verification vivent dans un bloc `try`, la restauration (via
// savePlayer(initialState), methode deja validee par
// testSavePlayerIntegration.ts) vit dans le `finally` correspondant -- un
// `finally` s'execute TOUJOURS, que le `try` se termine normalement ou par
// une exception (ex. la verification coins==52 echoue). Ca garantit que la
// restauration est tentee des que l'etat initial a ete lu avec succes, peu
// importe ce qui echoue ensuite. Les erreurs de la phase de concurrence et
// celles de la phase de restauration sont capturees SEPAREMENT (jamais
// l'une n'ecrase l'autre) et rapportees ensemble a la fin -- si l'une ou
// l'autre a echoue, le script sort avec le code 1.
//
// N'affiche jamais DATABASE_URL. Aucun DELETE/DROP/TRUNCATE, aucun reset
// global, aucun seed, aucune migration, aucun changement de schema.

import assert from "node:assert/strict";
import type { PlayerState } from "../types";

const TEST_PLAYER_ID = "v2-test-player-001";
const EXPECTED_PLOT_COUNT = 4;
const EXPECTED_INVENTORY_ENTRY_COUNT = 2;
const EXPECTED_INITIAL_COINS = 50;
const EXPECTED_INITIAL_LEVEL = 1;
const EXPECTED_COINS_AFTER_CONCURRENCY = 52;

// Meme logique que testSavePlayerIntegration.ts : savePlayer()/mutatePlayer()
// mettent a jour updatedAt=now() a chaque ecriture reussie -- ce n'est donc
// jamais compare par egalite stricte contre un etat "avant". A la place :
// les champs metier (tout sauf updatedAt, createdAt INCLUS -- doit rester
// strictement identique) sont compares par egalite stricte, et updatedAt
// est verifie separement : valeur valide (nombre fini positif) ET >= une
// reference (l'updatedAt d'AVANT cet appel precis).
function assertPlayerStateMatches(
  actual: PlayerState | null,
  expectedExceptUpdatedAt: PlayerState,
  minUpdatedAt: number,
  context: string,
): void {
  assert.ok(actual, `${context} : joueur introuvable.`);
  const { updatedAt: actualUpdatedAt, ...actualRest } = actual;
  const { updatedAt: _expectedUpdatedAt, ...expectedRest } = expectedExceptUpdatedAt;
  assert.deepStrictEqual(
    actualRest,
    expectedRest,
    `${context} : champs metier (hors updatedAt) different de l'attendu -- createdAt inclus dans cette comparaison, doit rester identique.`,
  );
  assert.equal(
    typeof actualUpdatedAt,
    "number",
    `${context} : updatedAt doit etre un nombre (epoch ms), recu ${typeof actualUpdatedAt}.`,
  );
  assert.ok(
    Number.isFinite(actualUpdatedAt) && actualUpdatedAt > 0,
    `${context} : updatedAt doit etre une valeur valide, recu ${actualUpdatedAt}.`,
  );
  assert.ok(
    actualUpdatedAt >= minUpdatedAt,
    `${context} : updatedAt (${actualUpdatedAt}) doit etre >= la reference attendue (${minUpdatedAt}).`,
  );
}

console.log(
  `[test-mutate-concurrency] NODE_ENV actuel : ${process.env.NODE_ENV ?? "(non defini)"} (indicatif uniquement, ne bloque pas).`,
);

console.log("[test-mutate-concurrency] Validation des garde-fous d'environnement...");

if (process.env.ALLOW_MUTATEPLAYER_CONCURRENCY_TEST !== "yes-mutateplayer-test-db") {
  console.error(
    '[test-mutate-concurrency] Garde-fou : definir ALLOW_MUTATEPLAYER_CONCURRENCY_TEST="yes-mutateplayer-test-db" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_CONFIRMATION !== "cedjeux-v2-test") {
  console.error(
    '[test-mutate-concurrency] Garde-fou : definir TEST_DATABASE_CONFIRMATION="cedjeux-v2-test" pour confirmer explicitement que la base ciblee est bien la base V2 TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[test-mutate-concurrency] DATABASE_URL est absente de l'environnement. Test annule.");
  process.exit(1);
}

console.log("[test-mutate-concurrency] Garde-fous d'environnement OK.");

async function run(): Promise<void> {
  const { pool } = await import("@workspace/db");
  const { getPlayer, getAllPlayers, mutatePlayer, savePlayer } = await import("./farmRepository.ts");

  try {
    console.log("[test-mutate-concurrency] Lecture de l'etat initial du joueur de test...");
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
    assert.equal(
      initialState.level,
      EXPECTED_INITIAL_LEVEL,
      `level=${EXPECTED_INITIAL_LEVEL} attendu au depart, trouve ${initialState.level} -- arret sans ecriture.`,
    );
    console.log("[test-mutate-concurrency] Garde-fous de ciblage OK -- base TEST confirmee, poursuite.");

    // --- Concurrence + restauration : la restauration (finally) s'execute
    // TOUJOURS, meme si la verification apres concurrence echoue. Les
    // erreurs des deux phases sont capturees separement, jamais l'une
    // n'ecrase l'autre. ---
    const errors: string[] = [];
    // Reference pour la verification updatedAt de la phase de restauration :
    // par defaut l'updatedAt initial (si la phase de concurrence n'a jamais
    // reussi a relire l'etat apres les deux mutations), mise a jour si elle
    // reussit.
    let updatedAtAfterConcurrency = initialState.updatedAt;

    try {
      console.log(
        `[test-mutate-concurrency] Lancement de DEUX mutatePlayer() EN PARALLELE (+1 coin chacune, depart coins=${EXPECTED_INITIAL_COINS})...`,
      );

      // Promise.all : les deux mutations sont demarrees ensemble, jamais
      // l'une apres l'autre. C'est precisement ce qui exerce la
      // serialisation par SELECT ... FOR UPDATE a l'interieur de
      // mutatePlayer() plutot qu'une simple execution sequentielle qui ne
      // prouverait rien sur la concurrence.
      await Promise.all([
        mutatePlayer(TEST_PLAYER_ID, (player) => {
          player.coins += 1;
        }),
        mutatePlayer(TEST_PLAYER_ID, (player) => {
          player.coins += 1;
        }),
      ]);

      console.log("[test-mutate-concurrency] Les deux mutations concurrentes se sont terminees sans exception.");

      const afterConcurrency = await getPlayer(TEST_PLAYER_ID);
      assertPlayerStateMatches(
        afterConcurrency,
        { ...initialState, coins: EXPECTED_COINS_AFTER_CONCURRENCY },
        initialState.updatedAt,
        "Apres les deux mutations concurrentes",
      );
      updatedAtAfterConcurrency = afterConcurrency!.updatedAt;
      console.log(
        `[test-mutate-concurrency] Resultat verifie avec succes : coins=${EXPECTED_COINS_AFTER_CONCURRENCY} (jamais 51 -- aucun lost update), level/plots/inventory/createdAt inchanges, updatedAt avance.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Phase de concurrence : ${message}`);
      console.error(`[test-mutate-concurrency] ECHEC phase de concurrence : ${message}`);
    } finally {
      console.log("[test-mutate-concurrency] Restauration de l'etat initial (tentee dans tous les cas)...");
      try {
        // savePlayer(initialState) : methode de restauration deja validee
        // par testSavePlayerIntegration.ts, reutilisee ici telle quelle.
        await savePlayer(initialState);
        const afterRestore = await getPlayer(TEST_PLAYER_ID);
        assertPlayerStateMatches(afterRestore, initialState, updatedAtAfterConcurrency, "Apres restauration");
        console.log(
          "[test-mutate-concurrency] Restauration verifiee avec succes (etat initial retrouve, updatedAt avance).",
        );
      } catch (restoreError) {
        const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
        errors.push(
          `ECHEC DE LA RESTAURATION : ${message} -- le joueur de test peut etre dans un etat modifie, verification manuelle necessaire.`,
        );
        console.error(`[test-mutate-concurrency] ${errors[errors.length - 1]}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`${errors.length} verification(s) en echec :\n- ${errors.join("\n- ")}`);
    }

    console.log(
      "[test-mutate-concurrency] Test de concurrence reussi de bout en bout -- etat TEST restaure a l'identique.",
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
    console.error("[test-mutate-concurrency] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
