// Test D'INTEGRATION REEL DE CONCURRENCE pour mutatePlayerAndGlobal(), contre
// la base V2 TEST (Neon TEST) UNIQUEMENT -- scenario "type sell" (DEUX
// joueurs DIFFERENTS mutant le MEME contrat simultanement). Jamais de
// donnee V1/production, jamais de DELETE/DROP/TRUNCATE, jamais de
// migration.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`.
//
// ETAT ACTUEL CONNU (a la redaction de ce script) : la base V2 TEST ne
// contient QU'UN SEUL joueur ("v2-test-player-001"). Le scenario le plus
// important pour sell() -- deux joueurs DIFFERENTS decrementant
// contract.remaining en meme temps -- exige DEUX joueurs distincts. Ce
// script NE CREE PAS de second joueur automatiquement et NE SEED PAS : il
// verifie strictement la presence de 2 joueurs et s'arrete PROPREMENT,
// SANS AUCUNE ECRITURE, si cette condition n'est pas remplie -- ce qui est
// le cas aujourd'hui. La decision d'ajouter un second joueur TEST sera
// prise separement.
//
// POURQUOI UNE MUTATION CONTROLEE PLUTOT QUE sell() REEL (une fois 2
// joueurs disponibles) : sell(player, global, itemId, amount) de
// ../farm.ts exige un inventaire precis (le joueur doit posseder une
// quantite non nulle de la ressource vendue) et une correspondance avec
// contract.cropId pour exercer le bonus de contrat -- des preconditions
// fragiles qu'on ne peut pas garantir sans seed/modification prealable
// (interdit ici). Ce script exerce donc directement
// mutatePlayerAndGlobal() avec un mutator CONTROLE qui touche EXACTEMENT
// la ressource que sell() ecrit reellement (contract.remaining) ainsi que
// le joueur (player.coins, comme proxy simple d'un gain de vente) -- sans
// reproduire le calcul de prix/bonus de contrat lui-meme, qui n'a pas sa
// place dans un script d'integration.
//
// GARDE-FOUS (tous doivent passer, dans l'ordre, avant toute lecture/ecriture) :
//  1. ALLOW_PLAYERGLOBAL_SELL_TEST doit etre exactement
//     "yes-playerglobal-sell-test-db".
//  2. TEST_DATABASE_CONFIRMATION doit etre exactement "cedjeux-v2-test".
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme protection (meme raisonnement que les
//  scripts precedents). Lu et logge a titre informatif uniquement.
//
// GARDE-FOU DE CIBLAGE CRITIQUE : EXACTEMENT 2 joueurs doivent etre
// presents (ni 1, ni 3 ou plus -- une base avec un nombre inattendu de
// joueurs n'est pas la base TEST connue et controlee). Si ce n'est pas le
// cas, le script logge le nombre de joueurs trouve et la condition
// manquante, puis s'arrete avec le code 1 SANS AVOIR RIEN LU DE PLUS NI
// RIEN ECRIT.
//
// GARDE-FOUS DE CIBLAGE ADDITIONNELS (si 2 joueurs presents) : global_state/
// contract/daily_challenge presents ; contract.remaining >= 2 (deux
// decrements de 1 doivent rester >= 0, meme raisonnement que
// testMutateGlobalStateConcurrency.ts).
//
// CONCURRENCE REELLE : les deux mutatePlayerAndGlobal() (un par joueur) sont
// lances via Promise.all -- JAMAIS sequentiellement. Chacun verrouille
// (SELECT ... FOR UPDATE) global_state -> contract -> daily_challenge ->
// SON PROPRE joueur, dans l'ordre canonique. Les deux transactions se
// disputent le MEME verrou contract (partage), mais chacune verrouille une
// ligne players DIFFERENTE -- aucun cycle d'attente possible (ordre
// identique pour les deux, seule la ressource "player" differe). Resultat
// attendu : contract.remaining = initial - 2 (jamais initial - 1 -- lost
// update), chaque joueur +1 coin independamment.
//
// ROBUSTESSE DE LA RESTAURATION (try/finally) : la phase de concurrence et
// sa verification vivent dans un bloc `try`, la restauration vit dans le
// `finally` correspondant. Restaure contract.remaining et les coins des
// deux joueurs.
//
// N'affiche jamais DATABASE_URL. Aucun DELETE/DROP/TRUNCATE, aucun reset
// global, aucun seed, aucune migration, aucun changement de schema.

import assert from "node:assert/strict";

const EXPECTED_PLAYER_COUNT = 2;
const MIN_REMAINING_FOR_TEST = 2;

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
    console.log("[test-player-global-sell] Lecture du nombre de joueurs presents...");
    const allPlayers = await getAllPlayers();

    // --- Garde-fou critique : ce test a besoin d'EXACTEMENT 2 joueurs.
    // La base TEST actuelle n'en contient qu'un seul -- arret propre, SANS
    // AUCUNE LECTURE/ECRITURE SUPPLEMENTAIRE, condition manquante expliquee
    // clairement. ---
    if (allPlayers.length !== EXPECTED_PLAYER_COUNT) {
      console.error(
        `[test-player-global-sell] CONDITION MANQUANTE : ce test exige exactement ${EXPECTED_PLAYER_COUNT} joueurs en base TEST (deux joueurs DIFFERENTS vendant sur le meme contrat), mais ${allPlayers.length} joueur(s) trouve(s) : [${allPlayers.map((p) => p.userId).join(", ")}].`,
      );
      console.error(
        "[test-player-global-sell] Aucune ecriture n'a ete tentee. Ce script ne cree PAS de second joueur automatiquement et ne fait AUCUN seed -- la decision d'ajouter un second joueur TEST doit etre prise separement, explicitement, en dehors de ce script.",
      );
      process.exit(1);
    }

    console.log(`[test-player-global-sell] 2 joueurs trouves : [${allPlayers.map((p) => p.userId).join(", ")}].`);
    const [playerAId, playerBId] = allPlayers.map((p) => p.userId) as [string, string];

    const initialPlayerA = await getPlayer(playerAId);
    const initialPlayerB = await getPlayer(playerBId);
    const initialGlobal = await getGlobalState();

    // --- Garde-fous de ciblage additionnels : rien n'est ecrit avant que
    // TOUS passent. ---
    assert.ok(initialPlayerA, `Joueur "${playerAId}" introuvable a la relecture -- arret sans ecriture.`);
    assert.ok(initialPlayerB, `Joueur "${playerBId}" introuvable a la relecture -- arret sans ecriture.`);
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

    try {
      console.log(
        `[test-player-global-sell] Lancement de DEUX mutatePlayerAndGlobal() EN PARALLELE (deux joueurs DIFFERENTS, -1 sur contract.remaining et +1 coin chacun)...`,
      );

      await Promise.all([
        mutatePlayerAndGlobal(playerAId, (player, global) => {
          player.coins += 1;
          global.contract.remaining -= 1;
        }),
        mutatePlayerAndGlobal(playerBId, (player, global) => {
          player.coins += 1;
          global.contract.remaining -= 1;
        }),
      ]);

      console.log("[test-player-global-sell] Les deux mutations concurrentes se sont terminees sans exception.");

      const afterPlayerA = await getPlayer(playerAId);
      const afterPlayerB = await getPlayer(playerBId);
      const afterGlobal = await getGlobalState();
      assert.ok(afterPlayerA, "Relecture apres concurrence : joueur A introuvable.");
      assert.ok(afterPlayerB, "Relecture apres concurrence : joueur B introuvable.");
      assert.ok(afterGlobal, "Relecture apres concurrence : etat global introuvable.");

      const expectedRemaining = initialGlobal.contract.remaining - 2;
      assert.equal(
        afterGlobal.contract.remaining,
        expectedRemaining,
        `contract.remaining=${afterGlobal.contract.remaining} attendu=${expectedRemaining} (jamais ${initialGlobal.contract.remaining - 1} -- decrement perdu entre les deux joueurs).`,
      );
      assert.equal(afterPlayerA.coins, initialPlayerA.coins + 1, "coins du joueur A incoherents.");
      assert.equal(afterPlayerB.coins, initialPlayerB.coins + 1, "coins du joueur B incoherents.");
      assert.ok(afterPlayerA.updatedAt >= initialPlayerA.updatedAt);
      assert.ok(afterPlayerB.updatedAt >= initialPlayerB.updatedAt);
      assert.equal(afterPlayerA.createdAt, initialPlayerA.createdAt);
      assert.equal(afterPlayerB.createdAt, initialPlayerB.createdAt);
      console.log(
        `[test-player-global-sell] Resultat verifie avec succes : contract.remaining=${expectedRemaining} (aucun lost update entre les deux joueurs), coins A et B independamment corrects.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Phase de concurrence : ${message}`);
      console.error(`[test-player-global-sell] ECHEC phase de concurrence : ${message}`);
    } finally {
      console.log(
        "[test-player-global-sell] Restauration de contract.remaining et des coins des deux joueurs (tentee dans tous les cas)...",
      );
      try {
        await mutatePlayerAndGlobal(playerAId, (player, global) => {
          player.coins = initialPlayerA.coins;
          global.contract.remaining = initialGlobal.contract.remaining;
        });
        await mutatePlayerAndGlobal(playerBId, (player) => {
          player.coins = initialPlayerB.coins;
        });
        const restoredPlayerA = await getPlayer(playerAId);
        const restoredPlayerB = await getPlayer(playerBId);
        const restoredGlobal = await getGlobalState();
        assert.ok(restoredPlayerA, "Relecture apres restauration : joueur A introuvable.");
        assert.ok(restoredPlayerB, "Relecture apres restauration : joueur B introuvable.");
        assert.ok(restoredGlobal, "Relecture apres restauration : etat global introuvable.");
        assert.equal(restoredPlayerA.coins, initialPlayerA.coins);
        assert.equal(restoredPlayerB.coins, initialPlayerB.coins);
        assert.equal(restoredGlobal.contract.remaining, initialGlobal.contract.remaining);
        console.log(
          "[test-player-global-sell] Restauration verifiee avec succes (contract.remaining et coins des deux joueurs retrouves a l'identique).",
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
      "[test-player-global-sell] Test de concurrence reussi de bout en bout -- etat TEST restaure a l'identique.",
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
