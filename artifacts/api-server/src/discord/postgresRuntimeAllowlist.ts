// LOT 6 -- bascule PostgreSQL TEST-ONLY, infrastructure uniquement.
//
// Cette fonction ne fait QUE repondre a la question "ce playerId a-t-il le
// droit d'utiliser le runtime PostgreSQL (encore experimental) ?" -- elle
// n'est appelee par AUCUNE commande a ce stade (voir presenters.ts,
// inchange). Aucun utilisateur non allowlisté ne peut donc voir son
// comportement changer suite a l'ajout de ce fichier : il n'est reference
// nulle part dans le chemin d'execution reel du bot.
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
// tout le monde, sans exception. Aucune valeur par defaut contenant un
// identifiant Discord reel n'existe dans ce fichier : en l'absence totale
// de configuration, cette fonction est un no-op garanti.
//
// AUCUN LOG : ni les IDs autorises, ni la valeur brute de la variable
// d'environnement, ne sont jamais ecrits en sortie par ce module (aucun
// console.*/logger.* ici) -- coherent avec la contrainte "aucun secret ne
// doit etre affiche" deja appliquee aux scripts d'integration du LOT 5.
export const POSTGRES_TEST_PLAYER_IDS_ENV_VAR = "FARM2WIN_POSTGRES_TEST_PLAYER_IDS";

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
 * le reste de ce dossier). Retourne `true` UNIQUEMENT si `playerId`, TEL
 * QUEL (jamais trim()), figure exactement dans la liste separee par
 * virgules de `FARM2WIN_POSTGRES_TEST_PLAYER_IDS` (dont chaque entree, elle,
 * est trim() avant comparaison -- voir le commentaire de section
 * ci-dessus). Ne branche, ne lit, ni n'ecrit quoi que ce soit d'autre --
 * purement une decision booleenne.
 */
export function shouldUsePostgresRuntime(
  playerId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const allowlist = parseAllowlist(env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR]);
  return allowlist.has(playerId);
}
