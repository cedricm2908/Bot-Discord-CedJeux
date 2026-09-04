// Script de SEED -- cree un DEUXIEME joueur TEST minimal dans Neon TEST,
// pour permettre les scenarios d'integration a deux joueurs (ex.
// testMutatePlayerAndGlobalSellConcurrency.ts : deux joueurs DIFFERENTS
// mutant le meme contract simultanement). Reserve EXCLUSIVEMENT a la base
// V2 TEST. Ne doit jamais toucher V1/production.
//
// GARDE-FOUS D'ENVIRONNEMENT (tous doivent passer, dans l'ordre, AVANT
// toute lecture/ecriture) :
//  1. Refuse si ALLOW_SECOND_TEST_PLAYER_SEED n'est pas exactement
//     "yes-create-second-test-player".
//  2. Refuse si TEST_DATABASE_CONFIRMATION n'est pas exactement
//     "cedjeux-v2-test".
//     Ces deux variables (1+2) sont dediees exclusivement a ce script, opt-in
//     explicite et volontaire, distinctes de DATABASE_URL -- meme principe
//     que seedTest.ts.
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  NODE_ENV n'est PAS utilise comme blocage a lui seul (meme raisonnement
//  que seedTest.ts : Railway fixe NODE_ENV=production sur tous ses
//  services, y compris celui de test). Lu et logge a titre informatif
//  uniquement.
//
// VALIDATION STRICTE AVANT ECRITURE (dans la transaction) -- exactement
// DEUX cas autorises, tout le reste est un ABORT sans aucune ecriture :
//   CAS A : exactement 1 joueur present, id = TEST_PLAYER_ID
//           -> creation de SECOND_TEST_PLAYER_ID autorisee.
//   CAS B : exactement 2 joueurs presents, ids = {TEST_PLAYER_ID,
//           SECOND_TEST_PLAYER_ID} exactement -> seed deja applique :
//           verifie que SECOND_TEST_PLAYER_ID correspond EXACTEMENT a
//           l'etat TEST attendu (tous les champs metier, hors les 3
//           timestamps intrinsequement variables createdAt/updatedAt/
//           questsResetAt) et que ses 4 parcelles sont vides et qu'aucun
//           inventory_item ne lui est associe -- si tout correspond, ne
//           modifie RIEN et termine avec succes ; si un seul champ differe,
//           ABORT (jamais de correction automatique).
//   TOUT AUTRE CAS (0 joueur, 3+ joueurs, joueur(s) avec id(s) inattendu(s),
//   ou CAS B partiellement/incoherent) -> ABORT avant toute ecriture.
//
// TOUT le seed s'execute dans UNE SEULE transaction PostgreSQL
// (db.transaction) : soit tout est cree (joueur + 4 parcelles), soit
// rollback automatique complet des la premiere erreur -- meme garantie que
// seedTest.ts.
//
// INVENTAIRE : delibrement AUCUN inventory_item cree pour ce joueur. Le
// seul consommateur prevu de ce second joueur
// (testMutatePlayerAndGlobalSellConcurrency.ts) utilise une mutation
// CONTROLEE de mutatePlayerAndGlobal() (player.coins += 1,
// global.contract.remaining -= 1), jamais sell() reel -- aucun inventaire
// n'est donc necessaire. C'est aussi la representation V2 fidele de
// l'inventaire vide par defaut de createPlayer() en V1 (toutes les
// cultures a 0) : en V2, "0" se traduit par l'ABSENCE de ligne
// inventory_items, jamais une ligne a quantite 0 (voir playerAdapter.ts :
// `inventory[itemId] ?? 0`).
//
// AUCUNE modification de global_state/contract/daily_challenge/
// daily_challenge_contributors/du premier joueur TEST -- ce script ne lit
// et n'ecrit QUE la table players (le second joueur) et la table plots (ses
// 4 parcelles).
//
// Aucun DELETE/DROP/TRUNCATE/UPDATE nulle part dans ce fichier -- uniquement
// des SELECT (validation) et des INSERT (creation, cas A uniquement).
//
// Identifiant de joueur volontairement NON numerique
// ("v2-test-player-002"), meme convention que TEST_PLAYER_ID -- un vrai id
// Discord (snowflake) est toujours purement numerique, donc aucune
// collision possible avec un utilisateur reel.
//
// N'affiche jamais DATABASE_URL.

// Force le mode module (aucun import/export statique sinon, a cause des
// imports dynamiques ci-dessous) : sans ça, ce fichier serait traite comme
// un script en portee globale et entrerait en collision avec seedTest.ts
// (meme noms de constantes TEST_PLAYER_ID/TEST_PLOT_INDEXES/databaseUrl,
// meme dossier).
export {};

const TEST_PLAYER_ID = "v2-test-player-001";
const SECOND_TEST_PLAYER_ID = "v2-test-player-002";
const TEST_PLOT_INDEXES = [0, 1, 2, 3] as const;

// Etat metier attendu pour le second joueur -- reutilise EXACTEMENT les
// memes valeurs par defaut/regles que seedTest.ts pour TEST_PLAYER_ID
// (aucune nouvelle regle metier inventee). Les 3 timestamps intrinsequement
// variables (createdAt/updatedAt/questsResetAt) sont exclus de cette
// constante : ils sont generes a la creation (CAS A) et exclus de la
// comparaison de coherence (CAS B).
const EXPECTED_SECOND_PLAYER_STATE = {
  coins: 50,
  level: 1,
  xp: 0,
  irrigationLevel: 0,
  fertilizerLevel: 0,
  lastDailyAt: null as Date | null,
  autoReplant: false,
  weeklySnapshotCoins: 50,
  totalHarvested: 0,
  quests: [
    { type: "harvest", label: "Recolter 10 cultures", target: 10, progress: 0, rewardCoins: 40, claimed: false },
    { type: "sell_value", label: "Vendre pour 100 pieces de valeur", target: 100, progress: 0, rewardCoins: 50, claimed: false },
    { type: "plant", label: "Planter 5 cultures", target: 5, progress: 0, rewardCoins: 30, claimed: false },
  ],
  plotSkin: "classic",
  unlockedSkins: ["classic"],
  // La valeur demandee "weatherForecast = false" ne correspond pas au type
  // reel de la colonne (text nullable, jamais booleen -- voir
  // lib/db/src/schema/players.ts). `null` est la valeur exacte utilisee par
  // createPlayer() en V1 et par seedTest.ts pour "aucune prevision achetee",
  // ce qui correspond a l'intention exprimee.
  weatherForecast: null as string | null,
};

console.log(
  `[seed-second-test-player] NODE_ENV actuel : ${process.env.NODE_ENV ?? "(non defini)"} (indicatif uniquement, ne bloque pas).`,
);

if (process.env.ALLOW_SECOND_TEST_PLAYER_SEED !== "yes-create-second-test-player") {
  console.error(
    '[seed-second-test-player] Garde-fou : definir ALLOW_SECOND_TEST_PLAYER_SEED="yes-create-second-test-player" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

if (process.env.TEST_DATABASE_CONFIRMATION !== "cedjeux-v2-test") {
  console.error(
    '[seed-second-test-player] Garde-fou : definir TEST_DATABASE_CONFIRMATION="cedjeux-v2-test" pour confirmer explicitement que la base ciblee est bien la base V2 TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[seed-second-test-player] DATABASE_URL est absente de l'environnement. Seed annule.");
  process.exit(1);
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function run(): Promise<void> {
  const { db, pool } = await import("./index");
  const { players, plots, inventoryItems } = await import("./schema");
  const { eq } = await import("drizzle-orm");

  try {
    console.log("[seed-second-test-player] Demarrage (DATABASE_URL confirmee presente, valeur jamais affichee).");

    await db.transaction(async (tx) => {
      // --- Validation stricte : exactement CAS A ou CAS B, sinon ABORT
      // avant toute ecriture. ---
      const allPlayers = await tx.select().from(players);
      const ids = allPlayers.map((p) => p.id).sort();

      const isCaseA = allPlayers.length === 1 && ids[0] === TEST_PLAYER_ID;
      const isCaseB =
        allPlayers.length === 2 &&
        ids.length === 2 &&
        ids[0] === TEST_PLAYER_ID &&
        ids[1] === SECOND_TEST_PLAYER_ID;

      if (!isCaseA && !isCaseB) {
        throw new Error(
          `Validation stricte echouee : etat de la base inattendu (${allPlayers.length} joueur(s) trouve(s) : [${ids.join(", ")}]). ` +
            `Attendu CAS A (exactement 1 joueur, "${TEST_PLAYER_ID}") ou CAS B (exactement 2 joueurs, "${TEST_PLAYER_ID}" et "${SECOND_TEST_PLAYER_ID}"). ` +
            "Aucune ecriture effectuee.",
        );
      }

      if (isCaseB) {
        // --- Seed deja applique : verifie la coherence exacte de
        // SECOND_TEST_PLAYER_ID, ne modifie RIEN. ---
        console.log(
          `[seed-second-test-player] CAS B : ${SECOND_TEST_PLAYER_ID} deja present -- verification de coherence (aucune ecriture).`,
        );

        const [existingSecondPlayer] = await tx
          .select()
          .from(players)
          .where(eq(players.id, SECOND_TEST_PLAYER_ID))
          .limit(1);
        if (!existingSecondPlayer) {
          throw new Error(
            `Incoherence CAS B : ${SECOND_TEST_PLAYER_ID} attendu present mais introuvable a la relecture. Aucune ecriture effectuee.`,
          );
        }

        const actualState = {
          coins: existingSecondPlayer.coins,
          level: existingSecondPlayer.level,
          xp: existingSecondPlayer.xp,
          irrigationLevel: existingSecondPlayer.irrigationLevel,
          fertilizerLevel: existingSecondPlayer.fertilizerLevel,
          lastDailyAt: existingSecondPlayer.lastDailyAt,
          autoReplant: existingSecondPlayer.autoReplant,
          weeklySnapshotCoins: existingSecondPlayer.weeklySnapshotCoins,
          totalHarvested: existingSecondPlayer.totalHarvested,
          quests: existingSecondPlayer.quests,
          plotSkin: existingSecondPlayer.plotSkin,
          unlockedSkins: existingSecondPlayer.unlockedSkins,
          weatherForecast: existingSecondPlayer.weatherForecast,
        };
        if (!isDeepEqual(actualState, EXPECTED_SECOND_PLAYER_STATE)) {
          throw new Error(
            `Incoherence CAS B : l'etat metier de ${SECOND_TEST_PLAYER_ID} ne correspond pas exactement a l'etat TEST attendu. ` +
              "Aucune correction automatique -- verification manuelle necessaire. Aucune ecriture effectuee.",
          );
        }

        const secondPlayerPlots = await tx
          .select()
          .from(plots)
          .where(eq(plots.playerId, SECOND_TEST_PLAYER_ID));
        const plotsAreEmptyAndComplete =
          secondPlayerPlots.length === TEST_PLOT_INDEXES.length &&
          TEST_PLOT_INDEXES.every((index) => {
            const plot = secondPlayerPlots.find((row) => row.plotIndex === index);
            return plot && plot.cropId === null && plot.plantedAt === null && plot.notifiedReady === false;
          });
        if (!plotsAreEmptyAndComplete) {
          throw new Error(
            `Incoherence CAS B : les parcelles de ${SECOND_TEST_PLAYER_ID} ne correspondent pas exactement a l'etat attendu (4 parcelles vides). Aucune ecriture effectuee.`,
          );
        }

        const secondPlayerInventory = await tx
          .select()
          .from(inventoryItems)
          .where(eq(inventoryItems.playerId, SECOND_TEST_PLAYER_ID));
        if (secondPlayerInventory.length !== 0) {
          throw new Error(
            `Incoherence CAS B : ${SECOND_TEST_PLAYER_ID} devait avoir un inventaire vide (0 ligne inventory_items), ${secondPlayerInventory.length} trouvee(s). Aucune ecriture effectuee.`,
          );
        }

        console.log(
          `[seed-second-test-player] CAS B confirme : ${SECOND_TEST_PLAYER_ID} correspond exactement a l'etat TEST attendu (etat metier, 4 parcelles vides, inventaire vide). Seed considere comme deja applique, rien a faire.`,
        );
        return;
      }

      // --- CAS A : creation de SECOND_TEST_PLAYER_ID + ses 4 parcelles,
      // dans cette meme transaction. ---
      console.log(
        `[seed-second-test-player] CAS A confirme : creation de ${SECOND_TEST_PLAYER_ID}...`,
      );

      const now = new Date();
      await tx.insert(players).values({
        id: SECOND_TEST_PLAYER_ID,
        coins: EXPECTED_SECOND_PLAYER_STATE.coins,
        level: EXPECTED_SECOND_PLAYER_STATE.level,
        xp: EXPECTED_SECOND_PLAYER_STATE.xp,
        irrigationLevel: EXPECTED_SECOND_PLAYER_STATE.irrigationLevel,
        fertilizerLevel: EXPECTED_SECOND_PLAYER_STATE.fertilizerLevel,
        lastDailyAt: EXPECTED_SECOND_PLAYER_STATE.lastDailyAt,
        autoReplant: EXPECTED_SECOND_PLAYER_STATE.autoReplant,
        weeklySnapshotCoins: EXPECTED_SECOND_PLAYER_STATE.weeklySnapshotCoins,
        totalHarvested: EXPECTED_SECOND_PLAYER_STATE.totalHarvested,
        quests: EXPECTED_SECOND_PLAYER_STATE.quests,
        questsResetAt: now,
        plotSkin: EXPECTED_SECOND_PLAYER_STATE.plotSkin,
        unlockedSkins: EXPECTED_SECOND_PLAYER_STATE.unlockedSkins,
        weatherForecast: EXPECTED_SECOND_PLAYER_STATE.weatherForecast,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`[seed-second-test-player] Joueur ${SECOND_TEST_PLAYER_ID} cree (defauts V1 : 50 pieces, niveau 1).`);

      for (const plotIndex of TEST_PLOT_INDEXES) {
        await tx.insert(plots).values({
          playerId: SECOND_TEST_PLAYER_ID,
          plotIndex,
          cropId: null,
          plantedAt: null,
          notifiedReady: false,
        });
      }
      console.log(`[seed-second-test-player] ${TEST_PLOT_INDEXES.length} parcelles vides creees pour ${SECOND_TEST_PLAYER_ID}.`);
      console.log(`[seed-second-test-player] Aucun inventory_item cree (inventaire vide par defaut, voir en-tete).`);

      // --- Verification explicite : aucune autre table touchee. Ce
      // commentaire documente l'invariant, non une operation. ---
      // global_state, contract, daily_challenge, daily_challenge_contributors
      // et le premier joueur TEST_PLAYER_ID ne sont ni lus (au-dela du
      // SELECT de validation ci-dessus) ni ecrits par ce script.
    });

    console.log(
      "[seed-second-test-player] Termine avec succes (transaction validee). Aucun DROP/TRUNCATE/UPDATE/DELETE execute.",
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
    console.error("[seed-second-test-player] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
