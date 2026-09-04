// Tests de postgresRuntimeAllowlist.ts (LOT 6, infrastructure uniquement).
// Fonction pure : `env` est toujours injecte explicitement (sauf le test
// dedie "7.", qui verifie le comportement par defaut sur process.env, en
// restaurant sa valeur initiale dans un `finally`) -- aucune connexion DB,
// aucun secret manipule.
import assert from "node:assert/strict";
import { test } from "node:test";
import { POSTGRES_TEST_PLAYER_IDS_ENV_VAR, shouldUsePostgresRuntime } from "./postgresRuntimeAllowlist.ts";

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
