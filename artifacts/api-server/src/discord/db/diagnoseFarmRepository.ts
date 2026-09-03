// Script de DIAGNOSTIC -- LECTURE SEULE STRICTE, utilise les exports REELS
// de farmRepository.ts (getPlayer/getAllPlayers/getGlobalState), pas les
// repositories/adaptateurs bas niveau directement.
//
// Isole du runtime principal : jamais importe par index.ts/app.ts/bot.ts,
// donc jamais execute par `pnpm start`. Aucun INSERT/UPDATE/DELETE, aucune
// transaction d'ecriture, aucune migration, aucune connexion Discord.
//
// N'affiche jamais DATABASE_URL, seulement sa presence/absence.
//
// Usage prevu (jamais depuis un poste local sans DATABASE_URL de TEST) :
//   pnpm --filter @workspace/api-server run diagnose:farm-repository

// Force le mode module (aucun import/export statique sinon, a cause des
// imports dynamiques ci-dessous) : sans ça, ce fichier serait traite comme
// un script en portee globale et entrerait en collision avec les autres
// scripts de diagnostic du meme dossier (ex. databaseUrl declare deux fois).
export {};

const TEST_PLAYER_ID = "v2-test-player-001";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "[diagnose-farm-repository] DATABASE_URL est absente de l'environnement. Diagnostic annule.",
  );
  process.exit(1);
}

async function run(): Promise<void> {
  // Import dynamique, apres la verification ci-dessus : @workspace/db leve
  // sa propre erreur si DATABASE_URL est absente au chargement du module.
  const { pool } = await import("@workspace/db");
  const { getPlayer, getAllPlayers, getGlobalState } = await import("./farmRepository.ts");

  try {
    console.log("[diagnose-farm-repository] Connexion via DATABASE_URL (valeur jamais affichee).");
    console.log("[diagnose-farm-repository] Lecture seule : farmRepository.getPlayer/getAllPlayers/getGlobalState uniquement.");
    console.log("");

    // --- 1. getPlayer(TEST_PLAYER_ID) ---
    const player = await getPlayer(TEST_PLAYER_ID);
    if (!player) {
      console.log(`[diagnose-farm-repository] getPlayer("${TEST_PLAYER_ID}") : ABSENT.`);
    } else {
      console.log(`[diagnose-farm-repository] getPlayer("${TEST_PLAYER_ID}") : PRESENT`);
      console.log(`[diagnose-farm-repository]   level=${player.level} coins=${player.coins}`);
      console.log(`[diagnose-farm-repository]   plots=${player.plots.length} objets_inventaire=${Object.keys(player.inventory).length}`);
    }

    console.log("");

    // --- 2. getAllPlayers() ---
    const allPlayers = await getAllPlayers();
    console.log(`[diagnose-farm-repository] getAllPlayers() : ${allPlayers.length} joueur(s) au total.`);

    console.log("");

    // --- 3. getGlobalState() ---
    const globalState = await getGlobalState();
    if (!globalState) {
      console.log("[diagnose-farm-repository] getGlobalState() : ABSENT.");
    } else {
      console.log("[diagnose-farm-repository] getGlobalState() : PRESENT");
      console.log(`[diagnose-farm-repository]   market_multiplier=x${globalState.marketMultiplier.toFixed(2)}`);
      console.log(`[diagnose-farm-repository]   weather=${globalState.weather} next_weather=${globalState.nextWeatherType}`);
      // getGlobalState() ne peut renvoyer un objet non-null que si contract
      // ET daily_challenge existent tous les deux (sinon getGlobalStateRecord
      // levait deja une erreur explicite, remontee par le .catch() ci-dessous
      // plutot que d'arriver ici) -- leur presence est donc garantie ici.
      console.log("[diagnose-farm-repository]   contract=PRESENT (garanti si getGlobalState() n'a pas leve d'erreur)");
      console.log("[diagnose-farm-repository]   daily_challenge=PRESENT (garanti si getGlobalState() n'a pas leve d'erreur)");
    }

    console.log("");
    console.log("[diagnose-farm-repository] Diagnostic termine -- lecture seule, aucune ecriture effectuee.");
  } finally {
    await pool.end();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[diagnose-farm-repository] Echec :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
