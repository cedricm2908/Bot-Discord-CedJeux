// Test D'INTEGRATION REEL DE CONCURRENCE pour mutatePlayerAndGlobal(), contre
// la base V2 TEST (Neon TEST) UNIQUEMENT -- scenario "type harvest" (joueur
// + defi quotidien mutes ensemble). Lance deux mutations concurrentes EN
// PARALLELE ciblant LE MEME joueur ET le MEME defi courant, verifie qu'elles
// se serialisent correctement (aucun lost update sur les deux ressources a
// la fois), puis restaure IMMEDIATEMENT et EXACTEMENT l'etat initial --
// jamais de donnee V1/production, jamais de DELETE/DROP/TRUNCATE, jamais de
// migration, et surtout AUCUNE DONNEE PERMANENTE laissee en base TEST.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`.
//
// POURQUOI UNE MUTATION CONTROLEE PLUTOT QUE harvest() REEL :
// harvest(player, global) de ../farm.ts ne produit un resultat que si le
// joueur a au moins une parcelle avec une culture PLANTEE ET ARRIVEE A
// MATURITE (plot.plantedAt + growMinutes <= now). L'etat exact des parcelles
// du joueur TEST au moment de l'execution de ce script n'est pas garanti
// (aucun seed dedie, aucune modification prealable importante autorisee ici
// -- consigne explicite : "n'invente pas"). Ce script exerce donc
// directement mutatePlayerAndGlobal() avec un mutator CONTROLE qui touche
// deux champs simples et surs (player.coins, dailyChallenge.progress) --
// sans en reproduire la logique metier complete (calcul du rendement,
// niveau/xp, replantation automatique, achievement...), qui n'a pas sa place
// dans un script d'integration et n'est pas necessaire pour prouver la
// garantie de concurrence de la primitive elle-meme.
//
// CONTRIBUTORS -- NE SONT PAS TOUCHES ICI, VOLONTAIREMENT : la regle de ce
// depot est stricte, un test d'integration doit laisser la base TEST
// EXACTEMENT dans son etat initial, et DELETE/DROP/TRUNCATE sont interdits.
// Or daily_challenge_contributors est un modele append-only SANS purge
// possible sans DELETE (voir lib/db/src/schema/dailyChallengeContributors.ts)
// -- ajouter un contributeur ici creerait donc une donnee PERMANENTE et non
// restaurable, ce qui est interdit. Les deux mutators de ce script laissent
// donc `dailyChallenge.contributors` STRICTEMENT INCHANGE (ni lecture ni
// ecriture de ce champ) : aucune ligne daily_challenge_contributors n'est
// jamais inseree par ce script, quel que soit l'etat initial des
// contributeurs du defi courant.
//   - La concurrence d'integration reelle est verifiee ici sur PLAYER
//     (coins) et sur DAILY_CHALLENGE (progress) -- les deux champs modifies
//     par harvest() qui sont surs et reversibles.
//   - L'UPSERT (INSERT ... ON CONFLICT DO NOTHING) des contributeurs est
//     deja couvert par les tests UNITAIRES de farmRepository.test.ts
//     ("mutatePlayerAndGlobal 14."/"15."), avec mocks -- pas de vraie base.
//   - Un vrai test d'INTEGRATION de l'insertion d'un contributeur
//     necessiterait soit une donnee TEST deja existante permettant un
//     scenario parfaitement reversible (ex. un defi de test dedie, jetable),
//     soit une strategie de nettoyage explicitement autorisee plus tard
//     (hors de portee de ce script, qui n'est pas autorise a faire de
//     DELETE) -- a decider separement, pas ici.
//
// GARDE-FOU SPECIFIQUE : le test exige
// `dailyChallenge.progress <= dailyChallenge.target - PROGRESS_HEADROOM_REQUIRED`
// AVANT toute ecriture (marge de 3, comme demande) -- deux incrementations
// de 1 ne doivent jamais faire franchir le seuil de completion
// (`completed`/`rewarded` sont geres par une logique metier -- distribution
// de recompense -- explicitement HORS PERIMETRE de ce lot, voir
// farm.ts:distributeDailyChallengeReward, pas encore portee en Postgres).
//
// GARDE-FOUS (tous doivent passer, dans l'ordre, avant toute lecture/ecriture) :
//  1. ALLOW_PLAYERGLOBAL_HARVEST_TEST doit etre exactement
//     "yes-playerglobal-harvest-test-db".
//  2. TEST_DATABASE_CONFIRMATION doit etre exactement "cedjeux-v2-test".
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme protection (meme raisonnement que les
//  scripts precedents). Lu et logge a titre informatif uniquement.
//
// GARDE-FOUS DE CIBLAGE (avant toute ecriture) : exactement 1 joueur au
// total, id "v2-test-player-001", coins=50, level=1, 4 parcelles, 2 entrees
// d'inventaire ; global_state/contract/daily_challenge presents ;
// dailyChallenge.progress <= dailyChallenge.target - PROGRESS_HEADROOM_REQUIRED.
//
// CONCURRENCE REELLE : les deux mutatePlayerAndGlobal() sont lances via
// Promise.all -- JAMAIS sequentiellement. Meme joueur ET meme defi pour les
// deux appels : chacun verrouille (SELECT ... FOR UPDATE) global_state ->
// contract -> daily_challenge -> le joueur, dans cet ordre canonique et
// IDENTIQUE pour les deux transactions -- aucun deadlock possible (deux
// transactions qui demandent les memes verrous dans le meme ordre se
// serialisent simplement, sans jamais former de cycle d'attente). Resultat
// attendu : coins = initial + 2, dailyChallenge.progress = initial + 2
// (jamais +1 seulement -- ce qui signifierait un decrement perdu sur l'une
// des deux ressources).
//
// RESTAURATION EXACTE (try/finally) : la phase de concurrence et sa
// verification vivent dans un bloc `try`, la restauration vit dans le
// `finally` correspondant -- toujours tentee. Restaure coins ET
// dailyChallenge.progress EXACTEMENT a leur valeur initiale, puis relit la
// DB et verifie une egalite metier COMPLETE : joueur identique (hors
// updatedAt, qui avance legitimement), etat global identique (hors
// updatedAt inexistant sur GlobalState), contract identique, contributors
// STRICTEMENT identiques (jamais touches). Aucune donnee residuelle.
//
// N'affiche jamais DATABASE_URL. Aucun DELETE/DROP/TRUNCATE, aucun reset
// global, aucun seed, aucune migration, aucun changement de schema.

import assert from "node:assert/strict";
import type { GlobalState, PlayerState } from "../types";

const TEST_PLAYER_ID = "v2-test-player-001";
const EXPECTED_PLOT_COUNT = 4;
const EXPECTED_INVENTORY_ENTRY_COUNT = 2;
const EXPECTED_INITIAL_COINS = 50;
const EXPECTED_INITIAL_LEVEL = 1;
const PROGRESS_HEADROOM_REQUIRED = 3;

// Meme logique que testSavePlayerIntegration.ts/testMutatePlayerConcurrency.ts :
// mutatePlayerAndGlobal() avance toujours updatedAt (joueur) a chaque
// ecriture reussie -- jamais compare par egalite stricte. Les champs
// joueur (tout sauf coins ET updatedAt -- coins est le champ sous test,
// compare separement) sont compares par egalite stricte ; updatedAt est
// verifie separement : valeur valide ET >= une reference.
function assertPlayerStateMatches(
  actual: PlayerState | null,
  expectedExceptCoins: PlayerState,
  expectedCoins: number,
  minUpdatedAt: number,
  context: string,
): void {
  assert.ok(actual, `${context} : joueur introuvable.`);
  const { coins: _actualCoins, updatedAt: actualUpdatedAt, ...actualRest } = actual;
  const { coins: _expectedCoins, updatedAt: _expectedUpdatedAt, ...expectedRest } = expectedExceptCoins;
  assert.deepStrictEqual(
    actualRest,
    expectedRest,
    `${context} : champs joueur (hors coins/updatedAt) different de l'attendu -- createdAt inclus, doit rester identique.`,
  );
  assert.equal(actual.coins, expectedCoins, `${context} : coins=${actual.coins} attendu=${expectedCoins}.`);
  assert.equal(typeof actualUpdatedAt, "number", `${context} : updatedAt doit etre un nombre.`);
  assert.ok(Number.isFinite(actualUpdatedAt) && actualUpdatedAt > 0, `${context} : updatedAt invalide.`);
  assert.ok(
    actualUpdatedAt >= minUpdatedAt,
    `${context} : updatedAt (${actualUpdatedAt}) doit etre >= la reference attendue (${minUpdatedAt}).`,
  );
}

// global_state n'a pas de colonne updated_at technique (voir farmRepository.ts) :
// comparaison stricte directe possible pour tout SAUF dailyChallenge.progress
// (le champ sous test). contributors fait partie de la comparaison stricte
// du defi (hors progress) -- doit donc rester RIGOUREUSEMENT identique.
function assertGlobalStateMatches(
  actual: GlobalState | null,
  expectedExceptProgress: GlobalState,
  expectedProgress: number,
  context: string,
): void {
  assert.ok(actual, `${context} : etat global introuvable.`);
  const { dailyChallenge: actualChallenge, ...actualRest } = actual;
  const { dailyChallenge: expectedChallenge, ...expectedRest } = expectedExceptProgress;
  assert.deepStrictEqual(
    actualRest,
    expectedRest,
    `${context} : champs globaux hors dailyChallenge different de l'attendu -- contract inclus, doit rester identique.`,
  );
  const { progress: _actualProgress, ...actualChallengeRest } = actualChallenge;
  const { progress: _expectedProgress, ...expectedChallengeRest } = expectedChallenge;
  assert.deepStrictEqual(
    actualChallengeRest,
    expectedChallengeRest,
    `${context} : champs du defi (hors progress) different de l'attendu -- contributors inclus, doit rester STRICTEMENT identique (jamais touche par ce script).`,
  );
  assert.equal(
    actual.dailyChallenge.progress,
    expectedProgress,
    `${context} : dailyChallenge.progress=${actual.dailyChallenge.progress} attendu=${expectedProgress}.`,
  );
}

console.log(
  `[test-player-global-harvest] NODE_ENV actuel : ${process.env.NODE_ENV ?? "(non defini)"} (indicatif uniquement, ne bloque pas).`,
);

console.log("[test-player-global-harvest] Validation des garde-fous d'environnement...");

if (process.env.ALLOW_PLAYERGLOBAL_HARVEST_TEST !== "yes-playerglobal-harvest-test-db") {
  console.error(
    '[test-player-global-harvest] Garde-fou : definir ALLOW_PLAYERGLOBAL_HARVEST_TEST="yes-playerglobal-harvest-test-db" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_CONFIRMATION !== "cedjeux-v2-test") {
  console.error(
    '[test-player-global-harvest] Garde-fou : definir TEST_DATABASE_CONFIRMATION="cedjeux-v2-test" pour confirmer explicitement que la base ciblee est bien la base V2 TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[test-player-global-harvest] DATABASE_URL est absente de l'environnement. Test annule.");
  process.exit(1);
}

console.log("[test-player-global-harvest] Garde-fous d'environnement OK.");

async function run(): Promise<void> {
  const { pool } = await import("@workspace/db");
  const { getPlayer, getAllPlayers, getGlobalState, mutatePlayerAndGlobal } = await import("./farmRepository.ts");

  try {
    console.log("[test-player-global-harvest] Lecture de l'etat initial (joueur + etat global)...");
    const initialPlayer = await getPlayer(TEST_PLAYER_ID);
    const initialGlobal = await getGlobalState();

    // --- Garde-fous de ciblage : rien n'est ecrit avant que TOUS passent ---
    assert.ok(
      initialPlayer,
      `Joueur "${TEST_PLAYER_ID}" absent -- ce n'est pas la base TEST attendue, arret sans ecriture.`,
    );
    const allPlayers = await getAllPlayers();
    assert.equal(
      allPlayers.length,
      1,
      `Nombre de joueurs attendu=1, trouve=${allPlayers.length} -- ce n'est pas la base TEST attendue, arret sans ecriture.`,
    );
    assert.equal(
      initialPlayer.coins,
      EXPECTED_INITIAL_COINS,
      `coins=${EXPECTED_INITIAL_COINS} attendu au depart, trouve ${initialPlayer.coins} -- arret sans ecriture.`,
    );
    assert.equal(
      initialPlayer.level,
      EXPECTED_INITIAL_LEVEL,
      `level=${EXPECTED_INITIAL_LEVEL} attendu au depart, trouve ${initialPlayer.level} -- arret sans ecriture.`,
    );
    assert.equal(
      initialPlayer.plots.length,
      EXPECTED_PLOT_COUNT,
      `${EXPECTED_PLOT_COUNT} parcelles attendues, trouve ${initialPlayer.plots.length} -- arret sans ecriture.`,
    );
    assert.equal(
      Object.keys(initialPlayer.inventory).length,
      EXPECTED_INVENTORY_ENTRY_COUNT,
      `${EXPECTED_INVENTORY_ENTRY_COUNT} entrees d'inventaire attendues, trouve ${Object.keys(initialPlayer.inventory).length} -- arret sans ecriture.`,
    );
    assert.ok(
      initialGlobal,
      "global_state/contract/daily_challenge introuvables -- ce n'est pas la base TEST attendue, arret sans ecriture.",
    );
    assert.ok(
      initialGlobal.dailyChallenge.progress <= initialGlobal.dailyChallenge.target - PROGRESS_HEADROOM_REQUIRED,
      `dailyChallenge.progress=${initialGlobal.dailyChallenge.progress} trop proche de target=${initialGlobal.dailyChallenge.target} pour ce scenario (marge >= ${PROGRESS_HEADROOM_REQUIRED} requise pour ne jamais declencher "completed") -- arret sans ecriture.`,
    );
    console.log(
      `[test-player-global-harvest] Garde-fous de ciblage OK -- base TEST confirmee. coins initial=${initialPlayer.coins}, dailyChallenge.progress initial=${initialGlobal.dailyChallenge.progress}/${initialGlobal.dailyChallenge.target}, contributors initiaux=[${initialGlobal.dailyChallenge.contributors.join(", ")}].`,
    );

    // --- Concurrence + restauration : la restauration (finally) s'execute
    // TOUJOURS, meme si la verification apres concurrence echoue. ---
    const errors: string[] = [];
    // Reference pour la verification updatedAt de la phase de restauration :
    // par defaut l'updatedAt initial, mise a jour si la phase de concurrence
    // reussit sa relecture.
    let updatedAtAfterConcurrency = initialPlayer.updatedAt;

    try {
      console.log(
        "[test-player-global-harvest] Lancement de DEUX mutatePlayerAndGlobal() EN PARALLELE (meme joueur, meme defi -- +1 coin et +1 progression chacune, contributors JAMAIS touches)...",
      );

      await Promise.all([
        mutatePlayerAndGlobal(TEST_PLAYER_ID, (player, global) => {
          player.coins += 1;
          global.dailyChallenge.progress += 1;
        }),
        mutatePlayerAndGlobal(TEST_PLAYER_ID, (player, global) => {
          player.coins += 1;
          global.dailyChallenge.progress += 1;
        }),
      ]);

      console.log("[test-player-global-harvest] Les deux mutations concurrentes se sont terminees sans exception.");

      const afterPlayer = await getPlayer(TEST_PLAYER_ID);
      const afterGlobal = await getGlobalState();

      const expectedCoins = initialPlayer.coins + 2;
      const expectedProgress = initialGlobal.dailyChallenge.progress + 2;
      assertPlayerStateMatches(afterPlayer, initialPlayer, expectedCoins, initialPlayer.updatedAt, "Apres concurrence");
      assertGlobalStateMatches(afterGlobal, initialGlobal, expectedProgress, "Apres concurrence");
      updatedAtAfterConcurrency = afterPlayer!.updatedAt;

      console.log(
        `[test-player-global-harvest] Resultat verifie avec succes : coins=${expectedCoins} (jamais ${initialPlayer.coins + 1}), dailyChallenge.progress=${expectedProgress} (jamais ${initialGlobal.dailyChallenge.progress + 1}) -- aucun lost update sur les deux ressources, contributors et contract strictement inchanges.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Phase de concurrence : ${message}`);
      console.error(`[test-player-global-harvest] ECHEC phase de concurrence : ${message}`);
    } finally {
      console.log(
        "[test-player-global-harvest] Restauration EXACTE de coins/dailyChallenge.progress (tentee dans tous les cas)...",
      );
      try {
        await mutatePlayerAndGlobal(TEST_PLAYER_ID, (player, global) => {
          player.coins = initialPlayer.coins;
          global.dailyChallenge.progress = initialGlobal.dailyChallenge.progress;
        });
        const restoredPlayer = await getPlayer(TEST_PLAYER_ID);
        const restoredGlobal = await getGlobalState();
        assertPlayerStateMatches(
          restoredPlayer,
          initialPlayer,
          initialPlayer.coins,
          updatedAtAfterConcurrency,
          "Apres restauration",
        );
        assertGlobalStateMatches(
          restoredGlobal,
          initialGlobal,
          initialGlobal.dailyChallenge.progress,
          "Apres restauration",
        );
        console.log(
          "[test-player-global-harvest] Restauration verifiee avec succes : joueur, etat global, contract et contributors STRICTEMENT identiques a l'etat initial -- aucune donnee residuelle.",
        );
      } catch (restoreError) {
        const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
        errors.push(
          `ECHEC DE LA RESTAURATION : ${message} -- le joueur/l'etat global TEST peuvent etre modifies, verification manuelle necessaire.`,
        );
        console.error(`[test-player-global-harvest] ${errors[errors.length - 1]}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`${errors.length} verification(s) en echec :\n- ${errors.join("\n- ")}`);
    }

    console.log(
      "[test-player-global-harvest] Test de concurrence reussi de bout en bout -- base TEST restauree a l'identique, aucune donnee permanente creee.",
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
    console.error("[test-player-global-harvest] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
