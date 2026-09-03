// Script de SEED -- cree un jeu de donnees TEST minimal dans Neon TEST.
// Reserve EXCLUSIVEMENT a la base V2 TEST. Ne doit jamais toucher V1/production.
//
// GARDE-FOUS (tous doivent passer, dans l'ordre) :
//  1. Refuse si NODE_ENV === "production".
//  2. Refuse si ALLOW_TEST_SEED n'est pas exactement "yes-seed-test-db" --
//     opt-in explicite et volontaire, distinct de DATABASE_URL. Necessaire
//     en plus du (1) : aucun Build/Start Railway de ce projet ne fixe
//     NODE_ENV pour l'instant, donc s'y fier seul serait insuffisant.
//  3. DATABASE_URL doit etre presente (jamais affichee).
//  4. Garde-fou de contenu (verifie DANS la transaction, avant toute
//     ecriture) : si la base contient deja plus de 5 joueurs ET qu'aucun
//     n'est TEST_PLAYER_ID, le seed refuse -- signal fort d'une base avec
//     de vraies donnees plutot qu'une base TEST vide/quasi vide. Ce garde-fou
//     ne lit jamais DATABASE_URL, seulement le contenu de la table players.
//
// TOUT le seed s'execute dans UNE SEULE transaction PostgreSQL
// (db.transaction) : soit tout est cree, soit rollback automatique complet
// des la premiere erreur (comportement natif de drizzle-orm : throw = rollback,
// pas de gestion manuelle necessaire).
//
// IDEMPOTENT, entite par entite (jamais "si le joueur existe -> tout sauter") :
// player, chacun des 4 plots, chaque inventory_item, global_state, contract et
// daily_challenge sont chacun verifies et crees INDEPENDAMMENT. Rien
// n'est jamais mis a jour ni ecrase si deja present -- uniquement des INSERT
// conditionnels. Aucun DELETE/DROP/TRUNCATE/UPDATE nulle part dans ce fichier.
//
// Identifiant de joueur volontairement NON numerique ("v2-test-player-001")
// -- un vrai id Discord (snowflake) est toujours purement numerique, donc
// aucune collision possible avec un utilisateur reel.
//
// N'affiche jamais DATABASE_URL.

const TEST_PLAYER_ID = "v2-test-player-001";
const TEST_PLOT_INDEXES = [0, 1, 2, 3] as const;
const TEST_INVENTORY = [
  // Quantites volontairement non nulles ajoutees UNIQUEMENT pour tester
  // l'adaptateur inventory_items -> inventory : ce n'est PAS l'inventaire
  // initial V1 (createPlayer() en V1 initialise toutes les cultures a 0,
  // jamais de quantite positive par defaut).
  { itemId: "wheat", quantity: 5 },
  { itemId: "carrot", quantity: 2 },
] as const;

if (process.env.NODE_ENV === "production") {
  console.error("[seed-test] NODE_ENV=production detecte -- execution refusee.");
  process.exit(1);
}

if (process.env.ALLOW_TEST_SEED !== "yes-seed-test-db") {
  console.error(
    '[seed-test] Garde-fou : definir ALLOW_TEST_SEED="yes-seed-test-db" pour confirmer explicitement une execution volontaire sur la base TEST.',
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[seed-test] DATABASE_URL est absente de l'environnement. Seed annule.");
  process.exit(1);
}

async function run(): Promise<void> {
  const { db, pool } = await import("./index");
  const {
    players,
    plots,
    inventoryItems,
    globalState,
    contract,
    dailyChallenge,
  } = await import("./schema");
  const { eq, and } = await import("drizzle-orm");

  try {
    console.log("[seed-test] Demarrage (DATABASE_URL confirmee presente, valeur jamais affichee).");

    await db.transaction(async (tx) => {
      // --- Garde-fou de contenu : refuse si la base ressemble a une base
      // avec de vraies donnees plutot qu'une base TEST vide/quasi vide ---
      const allPlayerIds = await tx.select({ id: players.id }).from(players);
      const looksLikeRealData =
        allPlayerIds.length > 5 && !allPlayerIds.some((row) => row.id === TEST_PLAYER_ID);
      if (looksLikeRealData) {
        throw new Error(
          `Garde-fou de contenu : ${allPlayerIds.length} joueurs deja presents et aucun n'est ${TEST_PLAYER_ID} -- ceci ne ressemble pas a une base TEST vide. Seed refuse, aucune ecriture effectuee.`,
        );
      }

      // --- Joueur de test : verifie et cree independamment. Ne modifie
      // jamais ses donnees s'il existe deja. ---
      const [existingPlayer] = await tx
        .select()
        .from(players)
        .where(eq(players.id, TEST_PLAYER_ID))
        .limit(1);

      if (existingPlayer) {
        console.log(`[seed-test] Joueur ${TEST_PLAYER_ID} deja present -- aucune modification.`);
      } else {
        const now = new Date();
        await tx.insert(players).values({
          id: TEST_PLAYER_ID,
          coins: 50,
          level: 1,
          xp: 0,
          irrigationLevel: 0,
          fertilizerLevel: 0,
          lastDailyAt: null,
          autoReplant: false,
          weeklySnapshotCoins: 50,
          totalHarvested: 0,
          quests: [
            { type: "harvest", label: "Recolter 10 cultures", target: 10, progress: 0, rewardCoins: 40, claimed: false },
            { type: "sell_value", label: "Vendre pour 100 pieces de valeur", target: 100, progress: 0, rewardCoins: 50, claimed: false },
            { type: "plant", label: "Planter 5 cultures", target: 5, progress: 0, rewardCoins: 30, claimed: false },
          ],
          questsResetAt: now,
          plotSkin: "classic",
          unlockedSkins: ["classic"],
          weatherForecast: null,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`[seed-test] Joueur ${TEST_PLAYER_ID} cree (defauts V1 : 50 pieces, niveau 1).`);
      }

      // --- Parcelles : chacune des 4 verifiee et creee independamment ---
      for (const plotIndex of TEST_PLOT_INDEXES) {
        const [existingPlot] = await tx
          .select()
          .from(plots)
          .where(and(eq(plots.playerId, TEST_PLAYER_ID), eq(plots.plotIndex, plotIndex)))
          .limit(1);
        if (existingPlot) {
          console.log(`[seed-test] Parcelle ${plotIndex} deja presente -- aucune modification.`);
        } else {
          await tx.insert(plots).values({
            playerId: TEST_PLAYER_ID,
            plotIndex,
            cropId: null,
            plantedAt: null,
            notifiedReady: false,
          });
          console.log(`[seed-test] Parcelle ${plotIndex} creee (vide, defaut V1).`);
        }
      }

      // --- Inventaire de test : chaque item verifie et cree independamment.
      // Si deja present, la quantite n'est JAMAIS incrementee ni remplacee. ---
      for (const item of TEST_INVENTORY) {
        const [existingItem] = await tx
          .select()
          .from(inventoryItems)
          .where(and(eq(inventoryItems.playerId, TEST_PLAYER_ID), eq(inventoryItems.itemId, item.itemId)))
          .limit(1);
        if (existingItem) {
          console.log(`[seed-test] Item d'inventaire "${item.itemId}" deja present -- quantite inchangee.`);
        } else {
          await tx.insert(inventoryItems).values({
            playerId: TEST_PLAYER_ID,
            itemId: item.itemId,
            quantity: item.quantity,
          });
          console.log(`[seed-test] Item d'inventaire "${item.itemId}" x${item.quantity} cree (donnee de test).`);
        }
      }

      // --- global_state : verifie et cree independamment (singleton id=1) ---
      const [existingGlobal] = await tx
        .select()
        .from(globalState)
        .where(eq(globalState.id, 1))
        .limit(1);
      if (existingGlobal) {
        console.log("[seed-test] global_state deja present -- aucune modification.");
      } else {
        const now = new Date();
        await tx.insert(globalState).values({
          id: 1,
          marketMultiplier: 1,
          previousMarketMultiplier: 1,
          marketUpdatedAt: now,
          weather: "normal",
          weatherMultiplier: 1,
          weatherChangedAt: null,
          weatherExpiresAt: null,
          // Valeur fixe de test : V1 tire aleatoirement entre 2h et 4h
          // (randomBetween(2*60*60*1000, 4*60*60*1000)) ; 3h est la valeur
          // mediane, choisie deliberement pour un seed reproductible.
          nextWeatherAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
          // Valeur fixe de test : V1 tire aleatoirement entre "rain" et
          // "pests" (randomWeatherType()). "rain" est fixe ici pour la
          // reproductibilite du seed, ce n'est pas un tirage reel.
          nextWeatherType: "rain",
          weeklyStartedAt: now,
        });
        console.log("[seed-test] global_state cree (defauts V1, meteo fixee pour reproductibilite).");
      }

      // --- contract : verifie et cree independamment de global_state
      // (singleton id=1) ---
      const [existingContract] = await tx
        .select()
        .from(contract)
        .where(eq(contract.id, 1))
        .limit(1);
      if (existingContract) {
        console.log("[seed-test] contract deja present -- aucune modification.");
      } else {
        await tx.insert(contract).values({
          id: 1,
          cropId: "wheat",
          required: 20,
          remaining: 20,
          bonusMultiplier: 1.6,
          renewedAt: new Date(),
        });
        console.log("[seed-test] contract cree (defaut V1 : ble, 20 requis, bonus x1.6).");
      }

      // --- daily_challenge : verifie et cree independamment. Aucune colonne
      // du schema ne permet d'identifier "le defi cree par ce seed"
      // specifiquement (pas de colonne source/tag, et le schema ne doit pas
      // etre modifie). Comme ce script ne cree plus de contributor (point 8),
      // il n'a plus besoin d'identifier PRECISEMENT sa propre ligne pour quoi
      // que ce soit en aval -- son seul besoin reel est "au moins un defi
      // existe". Le garde d'idempotence est donc "un daily_challenge existe
      // deja (qu'il vienne de ce seed ou d'une vraie partie) -> ne rien
      // creer", ce qui evite totalement le probleme d'identification sans
      // jamais risquer de dupliquer ou de mal interpreter un defi existant.
      const [anyChallenge] = await tx.select().from(dailyChallenge).limit(1);
      if (anyChallenge) {
        console.log(
          `[seed-test] Un daily_challenge existe deja (id=${anyChallenge.id}) -- aucune creation (peu importe qu'il vienne de ce seed ou d'une partie reelle).`,
        );
      } else {
        await tx.insert(dailyChallenge).values({
          // Configuration valide V1 (wheat/200/80 est l'une des 6 entrees
          // reelles de DAILY_CHALLENGE_TARGETS), mais fixee ici plutot que
          // tiree au hasard comme le fait randomDailyChallenge() en V1, pour
          // un seed reproductible.
          cropId: "wheat",
          target: 200,
          progress: 0,
          rewardCoins: 80,
          startedAt: new Date(),
          completed: false,
          rewarded: false,
        });
        console.log("[seed-test] daily_challenge cree (ble x200, recompense 80, progress=0, aucun contributor).");
      }

      // --- Contributeur : delibrement PAS cree. Un contributeur reel a par
      // definition fait progresser daily_challenge.progress (via une
      // recolte reelle). En creer un ici avec progress=0 produirait un etat
      // de jeu artificiellement incoherent. Le cas "contributors non vide"
      // sera teste plus tard avec une donnee coherente ou un test dedie.
    });

    console.log("[seed-test] Seed termine avec succes (transaction validee). Aucun DROP/TRUNCATE/UPDATE/DELETE execute.");
  } finally {
    await pool.end();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[seed-test] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
