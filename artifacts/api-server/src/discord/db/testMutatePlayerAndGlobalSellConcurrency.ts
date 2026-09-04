// Test D'INTEGRATION REEL DE CONCURRENCE pour mutatePlayerAndGlobal(), contre
// la base V2 TEST (Neon TEST) UNIQUEMENT -- scenario "type sell" (DEUX
// joueurs DIFFERENTS mutant le MEME contrat simultanement). Jamais de
// donnee V1/production, jamais de DELETE/DROP/TRUNCATE, jamais de
// migration.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`.
//
// JOUEURS CIBLES -- FIXES, PAS DERIVES DYNAMIQUEMENT : ce script exige
// EXACTEMENT les deux joueurs TEST connus, "v2-test-player-001" et
// "v2-test-player-002" (voir lib/db/src/seedSecondTestPlayer.ts pour la
// creation gardee du second). Une base contenant exactement 2 joueurs mais
// avec des IDs differents (ex. un joueur reel + un joueur TEST) N'EST PAS
// consideree comme la base attendue -- ABORT avant toute ecriture. Ce
// n'est plus "2 joueurs quelconques" : c'est precisement ces deux-la.
//
// POURQUOI UNE MUTATION CONTROLEE PLUTOT QUE sell() REEL : sell(player,
// global, itemId, amount) de ../farm.ts exige un inventaire precis (le
// joueur doit posseder une quantite non nulle de la ressource vendue) et
// une correspondance avec contract.cropId pour exercer le bonus de contrat
// -- des preconditions fragiles qu'on ne peut pas garantir sans seed/
// modification prealable specifique (hors de portee de ce script). Ce
// script exerce donc directement mutatePlayerAndGlobal() avec un mutator
// CONTROLE qui touche EXACTEMENT la ressource que sell() ecrit reellement
// (contract.remaining) ainsi que le joueur (player.coins, comme proxy
// simple d'un gain de vente) -- sans reproduire le calcul de prix/bonus de
// contrat lui-meme, qui n'a pas sa place dans un script d'integration.
// C'est pourquoi seedSecondTestPlayer.ts ne cree deliberement AUCUN
// inventory_item pour le second joueur (voir son en-tete).
//
// GARDE-FOUS (tous doivent passer, dans l'ordre, avant toute lecture/ecriture) :
//  1. ALLOW_PLAYERGLOBAL_SELL_TEST doit etre exactement
//     "yes-playerglobal-sell-test-db".
//  2. TEST_DATABASE_CONFIRMATION doit etre exactement "cedjeux-v2-test".
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme protection (meme raisonnement que les
//  scripts precedents). Lu et logge a titre informatif uniquement.
//
// GARDE-FOU DE CIBLAGE CRITIQUE : la base doit contenir EXACTEMENT les
// joueurs PLAYER_A_ID et PLAYER_B_ID -- ni plus, ni moins, ni des IDs
// differents. La comparaison se fait sur l'ensemble TRIE des IDs presents
// contre l'ensemble TRIE attendu (l'ordre de retour de getAllPlayers()
// n'est pas garanti). Si ce n'est pas le cas, le script logge les IDs
// trouves et la condition manquante, puis s'arrete avec le code 1 SANS
// AVOIR RIEN LU DE PLUS NI RIEN ECRIT.
//
// GARDE-FOUS DE CIBLAGE ADDITIONNELS (si les deux joueurs attendus sont
// presents) : global_state/contract/daily_challenge presents ;
// contract.remaining >= 2 (deux decrements de 1 doivent rester >= 0, meme
// raisonnement que testMutateGlobalStateConcurrency.ts).
//
// CONCURRENCE REELLE : les deux mutatePlayerAndGlobal() (un par joueur,
// PLAYER_A_ID et PLAYER_B_ID) sont lances via Promise.all -- JAMAIS
// sequentiellement. Chacun verrouille (SELECT ... FOR UPDATE) global_state
// -> contract -> daily_challenge -> SON PROPRE joueur, dans l'ordre
// canonique. Les deux transactions se disputent le MEME verrou contract
// (partage), mais chacune verrouille une ligne players DIFFERENTE -- aucun
// cycle d'attente possible (ordre identique pour les deux, seule la
// ressource "player" differe). Resultat attendu : contract.remaining =
// initial - 2 (jamais initial - 1 -- lost update), chaque joueur +1 coin
// independamment.
//
// VERIFICATION COMPLETE (pas seulement les champs modifies) : apres la
// concurrence ET apres la restauration, l'etat COMPLET des deux joueurs et
// de l'etat global est compare a l'etat initial -- tout champ hors
// coins/updatedAt (joueur) et hors contract.remaining (global, ce qui
// couvre aussi daily_challenge et contributors) doit rester STRICTEMENT
// identique. Seuls les updatedAt techniques peuvent legitimement avancer ;
// createdAt ne change jamais.
//
// ROBUSTESSE DE LA RESTAURATION (try/finally) : la phase de concurrence et
// sa verification vivent dans un bloc `try`, la restauration vit dans le
// `finally` correspondant -- toujours tentee. Restaure exactement coins A,
// coins B et contract.remaining, puis relit et verifie une egalite
// metier COMPLETE. Aucune donnee residuelle.
//
// N'affiche jamais DATABASE_URL. Aucun DELETE/DROP/TRUNCATE, aucun reset
// global, aucun seed, aucune migration, aucun changement de schema.

import assert from "node:assert/strict";
import type { GlobalState, PlayerState } from "../types";

const PLAYER_A_ID = "v2-test-player-001";
const PLAYER_B_ID = "v2-test-player-002";
const MIN_REMAINING_FOR_TEST = 2;

// Meme logique que testMutatePlayerAndGlobalHarvestConcurrency.ts :
// mutatePlayerAndGlobal() avance toujours updatedAt (joueur) a chaque
// ecriture reussie -- jamais compare par egalite stricte. Les champs
// joueur (tout sauf coins ET updatedAt -- coins est le champ sous test,
// compare separement) sont compares par egalite stricte (createdAt
// inclus, doit rester identique) ; updatedAt est verifie separement :
// valeur valide ET >= une reference.
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

// global_state n'a pas de colonne updated_at technique (voir
// farmRepository.ts) : comparaison stricte directe possible pour tout SAUF
// contract.remaining (le champ sous test). dailyChallenge (avec
// contributors) fait partie des champs hors contract, donc de la
// comparaison stricte -- doit rester RIGOUREUSEMENT identique, tout comme
// le reste du contrat (cropId/required/bonusMultiplier/renewedAt).
function assertGlobalStateMatches(
  actual: GlobalState | null,
  expectedExceptRemaining: GlobalState,
  expectedRemaining: number,
  context: string,
): void {
  assert.ok(actual, `${context} : etat global introuvable.`);
  const { contract: actualContract, ...actualRest } = actual;
  const { contract: expectedContract, ...expectedRest } = expectedExceptRemaining;
  assert.deepStrictEqual(
    actualRest,
    expectedRest,
    `${context} : champs globaux hors contract different de l'attendu -- dailyChallenge/contributors inclus, doivent rester identiques.`,
  );
  const { remaining: _actualRemaining, ...actualContractRest } = actualContract;
  const { remaining: _expectedRemaining, ...expectedContractRest } = expectedContract;
  assert.deepStrictEqual(
    actualContractRest,
    expectedContractRest,
    `${context} : champs du contrat hors remaining different de l'attendu.`,
  );
  assert.equal(
    actual.contract.remaining,
    expectedRemaining,
    `${context} : contract.remaining=${actual.contract.remaining} attendu=${expectedRemaining}.`,
  );
}

console.log(
  `[test-player-global-sell] NODE_ENV actuel : ${process.env.NODE_ENV ?? "(non defini)"} (indicatif uniquement, ne bloque pas).`,
);

console.log("[test-player-global-sell] Validation des garde-fous d'environnement...");

if (process.env.ALLOW_PLAYERGLOBAL_SELL_TEST !== "yes-playerglobal-sell-test-db") {
  console.error(
    '[test-player-global-sell] Garde-fou : definir ALLOW_PLAYERGLOBAL_SELL_TEST="yes-playerglobal-sell-test-db" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_CONFIRMATION !== "cedjeux-v2-test") {
  console.error(
    '[test-player-global-sell] Garde-fou : definir TEST_DATABASE_CONFIRMATION="cedjeux-v2-test" pour confirmer explicitement que la base ciblee est bien la base V2 TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[test-player-global-sell] DATABASE_URL est absente de l'environnement. Test annule.");
  process.exit(1);
}

console.log("[test-player-global-sell] Garde-fous d'environnement OK.");

async function run(): Promise<void> {
  const { pool } = await import("@workspace/db");
  const { getAllPlayers, getPlayer, getGlobalState, mutatePlayerAndGlobal } = await import("./farmRepository.ts");

  try {
    console.log("[test-player-global-sell] Lecture des joueurs presents...");
    const allPlayers = await getAllPlayers();
    const foundIds = allPlayers.map((p) => p.userId).sort();
    const expectedIds = [PLAYER_A_ID, PLAYER_B_ID].sort();

    // --- Garde-fou critique : la base doit contenir EXACTEMENT
    // {PLAYER_A_ID, PLAYER_B_ID}, ni plus, ni moins, ni des IDs differents
    // -- comparaison sur les ensembles TRIES. Arret propre, SANS AUCUNE
    // LECTURE/ECRITURE SUPPLEMENTAIRE, si ce n'est pas le cas. ---
    const idsMatchExactly =
      foundIds.length === expectedIds.length && foundIds.every((id, index) => id === expectedIds[index]);
    if (!idsMatchExactly) {
      console.error(
        `[test-player-global-sell] CONDITION MANQUANTE : ce test exige EXACTEMENT les joueurs [${expectedIds.join(", ")}], mais [${foundIds.join(", ") || "(aucun)"}] trouve(s).`,
      );
      console.error(
        "[test-player-global-sell] Aucune ecriture n'a ete tentee. Si le second joueur TEST n'existe pas encore, voir lib/db/src/seedSecondTestPlayer.ts (garde, non lance par ce script).",
      );
      process.exit(1);
    }

    console.log(`[test-player-global-sell] Joueurs attendus confirmes : [${PLAYER_A_ID}, ${PLAYER_B_ID}].`);

    const initialPlayerA = await getPlayer(PLAYER_A_ID);
    const initialPlayerB = await getPlayer(PLAYER_B_ID);
    const initialGlobal = await getGlobalState();

    // --- Garde-fous de ciblage additionnels : rien n'est ecrit avant que
    // TOUS passent. ---
    assert.ok(initialPlayerA, `Joueur "${PLAYER_A_ID}" introuvable a la relecture -- arret sans ecriture.`);
    assert.ok(initialPlayerB, `Joueur "${PLAYER_B_ID}" introuvable a la relecture -- arret sans ecriture.`);
    assert.ok(
      initialGlobal,
      "global_state/contract/daily_challenge introuvables -- ce n'est pas la base TEST attendue, arret sans ecriture.",
    );
    assert.ok(
      initialGlobal.contract.remaining >= MIN_REMAINING_FOR_TEST,
      `contract.remaining=${initialGlobal.contract.remaining} insuffisant pour ce scenario (>= ${MIN_REMAINING_FOR_TEST} requis) -- arret sans ecriture.`,
    );
    console.log(
      `[test-player-global-sell] Garde-fous de ciblage OK -- contract.remaining initial=${initialGlobal.contract.remaining}, coins A=${initialPlayerA.coins}, coins B=${initialPlayerB.coins}.`,
    );

    // --- Concurrence + restauration : la restauration (finally) s'execute
    // TOUJOURS, meme si la verification apres concurrence echoue. ---
    const errors: string[] = [];
    // References pour la verification updatedAt de la phase de
    // restauration : par defaut les updatedAt initiaux, mis a jour si la
    // phase de concurrence reussit sa relecture.
    let updatedAtAfterConcurrencyA = initialPlayerA.updatedAt;
    let updatedAtAfterConcurrencyB = initialPlayerB.updatedAt;

    try {
      console.log(
        "[test-player-global-sell] Lancement de DEUX mutatePlayerAndGlobal() EN PARALLELE (deux joueurs DIFFERENTS, -1 sur contract.remaining et +1 coin chacun)...",
      );

      await Promise.all([
        mutatePlayerAndGlobal(PLAYER_A_ID, (player, global) => {
          player.coins += 1;
          global.contract.remaining -= 1;
        }),
        mutatePlayerAndGlobal(PLAYER_B_ID, (player, global) => {
          player.coins += 1;
          global.contract.remaining -= 1;
        }),
      ]);

      console.log("[test-player-global-sell] Les deux mutations concurrentes se sont terminees sans exception.");

      const afterPlayerA = await getPlayer(PLAYER_A_ID);
      const afterPlayerB = await getPlayer(PLAYER_B_ID);
      const afterGlobal = await getGlobalState();

      const expectedRemaining = initialGlobal.contract.remaining - 2;
      assertPlayerStateMatches(
        afterPlayerA,
        initialPlayerA,
        initialPlayerA.coins + 1,
        initialPlayerA.updatedAt,
        "Apres concurrence (joueur A)",
      );
      assertPlayerStateMatches(
        afterPlayerB,
        initialPlayerB,
        initialPlayerB.coins + 1,
        initialPlayerB.updatedAt,
        "Apres concurrence (joueur B)",
      );
      assertGlobalStateMatches(afterGlobal, initialGlobal, expectedRemaining, "Apres concurrence");
      updatedAtAfterConcurrencyA = afterPlayerA!.updatedAt;
      updatedAtAfterConcurrencyB = afterPlayerB!.updatedAt;

      console.log(
        `[test-player-global-sell] Resultat verifie avec succes : contract.remaining=${expectedRemaining} (jamais ${initialGlobal.contract.remaining - 1} -- aucun lost update entre les deux joueurs), coins A et B independamment corrects, daily_challenge/contributors/reste de l'etat global strictement inchanges.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Phase de concurrence : ${message}`);
      console.error(`[test-player-global-sell] ECHEC phase de concurrence : ${message}`);
    } finally {
      console.log(
        "[test-player-global-sell] Restauration EXACTE de contract.remaining et des coins des deux joueurs (tentee dans tous les cas)...",
      );
      try {
        await mutatePlayerAndGlobal(PLAYER_A_ID, (player, global) => {
          player.coins = initialPlayerA.coins;
          global.contract.remaining = initialGlobal.contract.remaining;
        });
        await mutatePlayerAndGlobal(PLAYER_B_ID, (player) => {
          player.coins = initialPlayerB.coins;
        });
        const restoredPlayerA = await getPlayer(PLAYER_A_ID);
        const restoredPlayerB = await getPlayer(PLAYER_B_ID);
        const restoredGlobal = await getGlobalState();
        assertPlayerStateMatches(
          restoredPlayerA,
          initialPlayerA,
          initialPlayerA.coins,
          updatedAtAfterConcurrencyA,
          "Apres restauration (joueur A)",
        );
        assertPlayerStateMatches(
          restoredPlayerB,
          initialPlayerB,
          initialPlayerB.coins,
          updatedAtAfterConcurrencyB,
          "Apres restauration (joueur B)",
        );
        assertGlobalStateMatches(
          restoredGlobal,
          initialGlobal,
          initialGlobal.contract.remaining,
          "Apres restauration",
        );
        console.log(
          "[test-player-global-sell] Restauration verifiee avec succes : joueurs A/B, etat global, contract et contributors STRICTEMENT identiques a l'etat initial -- aucune donnee residuelle.",
        );
      } catch (restoreError) {
        const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
        errors.push(
          `ECHEC DE LA RESTAURATION : ${message} -- l'etat des joueurs/global TEST peut etre modifie, verification manuelle necessaire.`,
        );
        console.error(`[test-player-global-sell] ${errors[errors.length - 1]}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`${errors.length} verification(s) en echec :\n- ${errors.join("\n- ")}`);
    }

    console.log(
      "[test-player-global-sell] Test de concurrence reussi de bout en bout -- base TEST restauree a l'identique, aucune donnee residuelle.",
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
    console.error("[test-player-global-sell] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
