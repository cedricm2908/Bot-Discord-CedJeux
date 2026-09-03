// Script de DIAGNOSTIC Phase 3 -- LECTURE SEULE STRICTE.
//
// Volontairement isole du runtime principal : jamais importe par index.ts,
// app.ts ou bot.ts, donc jamais execute par `pnpm start`. N'utilise que des
// fonctions de lecture deja validees (getPlayerRecord/getAllPlayerRecords/
// getGlobalStateRecord + les adaptateurs) -- aucun INSERT/UPDATE/DELETE/
// UPSERT, aucune creation automatique de joueur ou de global_state, aucune
// migration, aucun seed, aucune connexion Discord.
//
// N'affiche jamais DATABASE_URL, seulement sa presence/absence.
//
// Usage prevu (jamais depuis un poste local sans DATABASE_URL de TEST) :
//   pnpm --filter @workspace/api-server run diagnose:db

// Force le mode module (aucun import/export statique sinon, a cause des
// imports dynamiques ci-dessous) : sans ça, ce fichier serait traite comme
// un script en portee globale et entrerait en collision avec les autres
// scripts de diagnostic du meme dossier (ex. databaseUrl declare deux fois).
export {};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "[diagnose] DATABASE_URL est absente de l'environnement. Diagnostic annule.",
  );
  process.exit(1);
}

async function run(): Promise<void> {
  // Import dynamique, apres la verification ci-dessus : @workspace/db leve
  // sa propre erreur si DATABASE_URL est absente au chargement du module,
  // on evite donc de charger quoi que ce soit avant d'avoir verifie nous-memes.
  const { pool } = await import("@workspace/db");
  const { getAllPlayerRecords, getGlobalStateRecord } = await import(
    "@workspace/db/repositories"
  );
  const { toPlayerState } = await import("./playerAdapter.ts");
  const { toGlobalState } = await import("./globalStateAdapter.ts");

  try {
    console.log("[diagnose] Connexion via DATABASE_URL (valeur jamais affichee).");
    console.log("[diagnose] Lecture seule : aucun INSERT/UPDATE/DELETE ne sera execute.");
    console.log("");

    const playerRecords = await getAllPlayerRecords();
    console.log(`[diagnose] Joueurs trouves : ${playerRecords.length}`);
    if (playerRecords.length === 0) {
      console.log(
        "[diagnose] Aucun joueur en base -- normal si la base TEST est vide ou pas encore utilisee. Ce n'est pas une erreur.",
      );
    } else {
      for (const record of playerRecords) {
        const state = toPlayerState(record);
        console.log(
          `[diagnose]   - id=${state.userId} niveau=${state.level} coins=${state.coins} parcelles=${state.plots.length} objets_inventaire=${Object.keys(state.inventory).length}`,
        );
      }
    }

    console.log("");
    const globalRecord = await getGlobalStateRecord();
    if (!globalRecord) {
      console.log(
        "[diagnose] global_state : ABSENT -- base TEST non initialisee. Ce n'est pas une erreur (aucune creation automatique n'est faite par ce script).",
      );
      console.log("[diagnose] contract : n/a (global_state absent)");
      console.log("[diagnose] daily_challenge : n/a (global_state absent)");
    } else {
      console.log("[diagnose] global_state : PRESENT (id=1)");
      console.log(`[diagnose] contract : PRESENT (id=${globalRecord.contract.id})`);
      console.log(
        `[diagnose] daily_challenge : PRESENT (id=${globalRecord.dailyChallenge.id}, ${globalRecord.dailyChallengeContributors.length} contributeur(s))`,
      );
      const state = toGlobalState(globalRecord);
      console.log(
        `[diagnose]   marche=x${state.marketMultiplier.toFixed(2)} meteo=${state.weather} prochaine_meteo=${state.nextWeatherType}`,
      );
    }

    console.log("");
    console.log("[diagnose] Diagnostic termine -- lecture seule, aucune ecriture effectuee.");
  } finally {
    await pool.end();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[diagnose] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
