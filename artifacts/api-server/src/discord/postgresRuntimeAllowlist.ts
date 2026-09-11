// LOT 6 (allowlist TEST-ONLY) + LOT V2-POSTGRES-ALL-USERS (bascule
// production) -- SEUL point de decision "ce playerId doit-il utiliser le
// runtime PostgreSQL ?" pour tout Farm2Win V2 (slash commands via
// presenters.ts, Discord Activity via routes/activity.ts). Centralise ici
// et nulle part ailleurs : tout appelant passe par cette fonction, jamais
// par une verification dupliquee/parallele -- exactement ce qui permet a
// CE SEUL fichier de faire passer TOUT Farm2Win V2 en PostgreSQL sans
// toucher un seul appelant.
//
// FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED="true" (comparaison stricte,
// process.env.X === "true" -- toute autre valeur, y compris "1"/"TRUE"/
// vide/absente, est traitee comme false, sans ambiguite) fait retourner
// `true` INCONDITIONNELLEMENT, pour N'IMPORTE QUEL playerId, sans lire
// l'allowlist -- c'est le mode cible de production V2 : tout nouveau
// Discord ID passe par ensurePlayerExists()/PostgreSQL des sa toute
// premiere interaction, sans jamais avoir besoin d'etre ajoute a une
// liste manuelle.
//
// Quand ce flag est absent/false, le comportement HISTORIQUE (allowlist
// TEST_PLAYER_IDS) reste disponible tel quel -- mecanisme de secours pour
// un rollback immediat (FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED=false) sans
// perdre la capacite de tester des joueurs individuels avant une
// reactivation complete.
//
// Format de la variable d'environnement FARM2WIN_POSTGRES_TEST_PLAYER_IDS :
// une liste d'IDs Discord separes par des virgules ("id1,id2,id3"). Seules
// les entrees de l'ENV sont trim() (la faute de frappe humaine -- espace
// apres une virgule -- vient de la, jamais du playerId reel). Le playerId
// FOURNI PAR L'APPELANT n'est PAS trim() : un snowflake Discord
// (interaction.user.id) n'a jamais d'espace, et comparer TEL QUEL garde la
// porte fermee par defaut (fail-closed) si un futur bug ailleurs venait un
// jour a construire un playerId avec un espace parasite -- ce serait alors
// un echec de comparaison (donc `false`, sans consequence), jamais un
// trim() qui absorberait silencieusement l'anomalie et risquerait de
// router un joueur non prevu vers le runtime experimental. La comparaison
// reste EGALITE STRICTE, jamais inclusion/prefixe/sous-chaine : un ID
// partiel ou visuellement proche ne doit jamais matcher un ID different.
//
// Variable absente OU vide (chaine vide, ou uniquement des virgules/espaces
// qui ne produisent aucun ID apres filtrage) => liste vide => false pour
// tout le monde, sans exception (sauf si ALL_PLAYERS_ENABLED="true", qui
// prime toujours). Aucune valeur par defaut contenant un identifiant
// Discord reel n'existe dans ce fichier : en l'absence totale de
// configuration, cette fonction est un no-op garanti (false pour tous).
//
// AUCUN LOG : ni les IDs autorises, ni la valeur brute d'une variable
// d'environnement, ne sont jamais ecrits en sortie par ce module (aucun
// console.*/logger.* ici) -- coherent avec la contrainte "aucun secret ne
// doit etre affiche" deja appliquee aux scripts d'integration du LOT 5.
export const POSTGRES_TEST_PLAYER_IDS_ENV_VAR = "FARM2WIN_POSTGRES_TEST_PLAYER_IDS";
export const POSTGRES_ALL_PLAYERS_ENABLED_ENV_VAR = "FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED";

function parseAllowlist(rawValue: string | undefined): Set<string> {
  if (!rawValue) return new Set();
  const ids = rawValue
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return new Set(ids);
}

/**
 * LECTURE SEULE, fonction PURE (aucun I/O au-dela de la lecture de `env`,
 * injectable pour les tests -- meme convention de dependance explicite que
 * le reste de ce dossier).
 *
 * 1. Si `FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED` vaut EXACTEMENT "true" :
 *    retourne `true` pour tout `playerId`, sans lire l'allowlist -- mode
 *    cible de production V2.
 * 2. Sinon, retourne `true` UNIQUEMENT si `playerId`, TEL QUEL (jamais
 *    trim()), figure exactement dans la liste separee par virgules de
 *    `FARM2WIN_POSTGRES_TEST_PLAYER_IDS` (dont chaque entree, elle, est
 *    trim() avant comparaison -- voir le commentaire de section
 *    ci-dessus) -- mode allowlist historique, disponible en secours.
 *
 * Ne branche, ne lit, ni n'ecrit quoi que ce soit d'autre -- purement une
 * decision booleenne.
 */
export function shouldUsePostgresRuntime(
  playerId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env[POSTGRES_ALL_PLAYERS_ENABLED_ENV_VAR] === "true") return true;
  const allowlist = parseAllowlist(env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR]);
  return allowlist.has(playerId);
}
