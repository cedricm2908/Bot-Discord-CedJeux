// Tests de postgresRuntimeAllowlist.ts (LOT 6, infrastructure uniquement).
// Fonction pure : `env` est toujours injecte explicitement (sauf le test
// dedie "7.", qui verifie le comportement par defaut sur process.env, en
// restaurant sa valeur initiale dans un `finally`) -- aucune connexion DB,
// aucun secret manipule.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  POSTGRES_ALL_PLAYERS_ENABLED_ENV_VAR,
  POSTGRES_TEST_PLAYER_IDS_ENV_VAR,
  shouldUsePostgresRuntime,
} from "./postgresRuntimeAllowlist.ts";

const TEST_PLAYER_ID_1 = "v2-test-player-001";
const TEST_PLAYER_ID_2 = "v2-test-player-002";

test("shouldUsePostgresRuntime 1. variable absente : false pour tout le monde", () => {
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1, {}), false);
});

test("shouldUsePostgresRuntime 2. variable vide (chaine vide) : false pour tout le monde", () => {
  const env = { [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: "" };
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1, env), false);
});

test("shouldUsePostgresRuntime 2bis. variable composee uniquement de virgules/espaces : false pour tout le monde", () => {
  const env = { [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: " , ,  , " };
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1, env), false);
});

test("shouldUsePostgresRuntime 3. un seul ID present : true uniquement pour lui", () => {
  const env = { [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: TEST_PLAYER_ID_1 };
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1, env), true);
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_2, env), false);
});

test("shouldUsePostgresRuntime 4. plusieurs IDs separes par virgule : chacun autorise, un ID absent de la liste ne l'est pas", () => {
  const env = { [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: `${TEST_PLAYER_ID_1},${TEST_PLAYER_ID_2}` };
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1, env), true);
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_2, env), true);
  assert.equal(shouldUsePostgresRuntime("v2-test-player-003", env), false);
});

test("shouldUsePostgresRuntime 5. espaces autour des IDs dans l'ENV correctement trim (cote env uniquement)", () => {
  const env = { [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: `  ${TEST_PLAYER_ID_1} , ${TEST_PLAYER_ID_2}  ` };
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1, env), true);
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_2, env), true);
});

test("shouldUsePostgresRuntime 5bis. le playerId RECU n'est jamais trim() -- un espace parasite echoue proprement (fail-closed)", () => {
  const env = { [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: "12345" };
  assert.equal(shouldUsePostgresRuntime("12345", env), true);
  assert.equal(
    shouldUsePostgresRuntime(" 12345 ", env),
    false,
    "un playerId avec des espaces ne doit JAMAIS matcher un ID allowliste, meme si sa version trim() correspondrait",
  );
});

test("shouldUsePostgresRuntime 6. ID partiel/similaire : jamais de correspondance par inclusion/prefixe/suffixe", () => {
  const env = { [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: TEST_PLAYER_ID_1 };
  assert.equal(shouldUsePostgresRuntime("v2-test-player-0", env), false);
  assert.equal(shouldUsePostgresRuntime("v2-test-player-0011", env), false);
  assert.equal(shouldUsePostgresRuntime("2-test-player-001", env), false);
});

test("shouldUsePostgresRuntime 7. sans `env` fourni, lit process.env (aucune valeur par defaut contenant un vrai ID)", () => {
  const original = process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
  try {
    delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1), false);
  } finally {
    if (original === undefined) delete process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR];
    else process.env[POSTGRES_TEST_PLAYER_IDS_ENV_VAR] = original;
  }
});

// ===========================================================================
// LOT V2-POSTGRES-ALL-USERS -- FARM2WIN_POSTGRES_ALL_PLAYERS_ENABLED
// ===========================================================================

test("shouldUsePostgresRuntime 8. ALL_PLAYERS_ENABLED=\"true\" -> true pour N'IMPORTE QUEL playerId, y compris un Discord ID jamais vu, sans allowlist", () => {
  const env = { [POSTGRES_ALL_PLAYERS_ENABLED_ENV_VAR]: "true" };
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1, env), true);
  assert.equal(shouldUsePostgresRuntime("un-tout-nouveau-joueur-jamais-vu", env), true);
  assert.equal(shouldUsePostgresRuntime("", env), true, "meme une chaine vide (cas limite) suit la regle inconditionnelle");
});

test("shouldUsePostgresRuntime 9. ALL_PLAYERS_ENABLED absent/false -> comportement allowlist historique inchange (rollback)", () => {
  const envAbsent = { [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: TEST_PLAYER_ID_1 };
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1, envAbsent), true, "allowlist toujours active si le flag global est absent");
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_2, envAbsent), false);

  const envFalse = { [POSTGRES_ALL_PLAYERS_ENABLED_ENV_VAR]: "false", [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: TEST_PLAYER_ID_1 };
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_1, envFalse), true);
  assert.equal(shouldUsePostgresRuntime(TEST_PLAYER_ID_2, envFalse), false, "un joueur hors allowlist reste sur JSON quand le flag global est explicitement false");
});

test("shouldUsePostgresRuntime 10. valeurs ambigues (\"1\", \"TRUE\", \" true \", \"yes\") ne sont JAMAIS traitees comme activees -- comparaison stricte ===\"true\"", () => {
  for (const value of ["1", "TRUE", " true ", "yes", "on", "True"]) {
    const env = { [POSTGRES_ALL_PLAYERS_ENABLED_ENV_VAR]: value };
    assert.equal(
      shouldUsePostgresRuntime(TEST_PLAYER_ID_1, env),
      false,
      `"${value}" ne doit pas activer le mode ALL_PLAYERS (seule la chaine exacte "true" le fait)`,
    );
  }
});

test("shouldUsePostgresRuntime 11. ALL_PLAYERS_ENABLED=\"true\" prime TOUJOURS, meme si l'allowlist est vide ou ne contient pas le joueur", () => {
  const env = { [POSTGRES_ALL_PLAYERS_ENABLED_ENV_VAR]: "true", [POSTGRES_TEST_PLAYER_IDS_ENV_VAR]: "" };
  assert.equal(shouldUsePostgresRuntime("joueur-totalement-absent-de-toute-liste", env), true);
});
