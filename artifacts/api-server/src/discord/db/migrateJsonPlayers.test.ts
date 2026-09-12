// LOT V2-POSTGRES-ALL-USERS -- tests de l'importeur JSON -> PostgreSQL
// (migrateJsonPlayers.ts), contre des FIXTURES uniquement -- AUCUNE
// connexion Neon/Railway, jamais main()/le CLI reel invoques ici.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { importJsonPlayers, type JsonPlayerImportDeps } from "./migrateJsonPlayers.ts";
import { freshQuests, STARTING_COINS, STARTING_PLOTS } from "../constants.ts";
import type { PlayerState } from "../types";

const NOW = 1_700_000_000_000;

function buildJsonPlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    userId: "json-player-fixture",
    coins: 342,
    level: 4,
    xp: 17,
    plots: [
      { cropId: "wheat", plantedAt: NOW - 1000, notifiedReady: false },
      { cropId: null, plantedAt: null, notifiedReady: false },
    ],
    inventory: { wheat: 6, carrot: 2 },
    irrigationLevel: 2,
    fertilizerLevel: 1,
    lastDailyAt: NOW - 5000,
    autoReplant: true,
    weeklySnapshotCoins: 300,
    createdAt: NOW - 100_000,
    updatedAt: NOW,
    totalHarvested: 25,
    quests: freshQuests(),
    questsResetAt: NOW,
    plotSkin: "classic",
    unlockedSkins: ["classic"],
    weatherForecast: null,
    ...overrides,
  };
}

function buildDeps(existingPostgresPlayers: Set<string> = new Set()): JsonPlayerImportDeps & {
  getPlayerCalls: string[];
  ensurePlayerExistsCalls: string[];
  mutatePlayerCalls: string[];
  importedPlayers: Map<string, PlayerState>;
} {
  const importedPlayers = new Map<string, PlayerState>();
  const getPlayerCalls: string[] = [];
  const ensurePlayerExistsCalls: string[] = [];
  const mutatePlayerCalls: string[] = [];

  const getPlayer = mock.fn(async (playerId: string) => {
    getPlayerCalls.push(playerId);
    return existingPostgresPlayers.has(playerId) ? ({ userId: playerId } as PlayerState) : null;
  }) as unknown as JsonPlayerImportDeps["getPlayer"];

  const ensurePlayerExists = mock.fn(async (playerId: string) => {
    ensurePlayerExistsCalls.push(playerId);
    const fresh: PlayerState = {
      userId: playerId,
      coins: STARTING_COINS,
      level: 1,
      xp: 0,
      plots: Array.from({ length: STARTING_PLOTS }, () => ({ cropId: null, plantedAt: null, notifiedReady: false })),
      inventory: {},
      irrigationLevel: 0,
      fertilizerLevel: 0,
      lastDailyAt: null,
      autoReplant: false,
      weeklySnapshotCoins: STARTING_COINS,
      createdAt: NOW,
      updatedAt: NOW,
      totalHarvested: 0,
      quests: freshQuests(),
      questsResetAt: NOW,
      plotSkin: "classic",
      unlockedSkins: ["classic"],
      weatherForecast: null,
    };
    importedPlayers.set(playerId, fresh);
    return { player: fresh, created: true };
  }) as unknown as JsonPlayerImportDeps["ensurePlayerExists"];

  const mutatePlayer = mock.fn(async (playerId: string, mutator: (player: PlayerState) => void | Promise<void>) => {
    mutatePlayerCalls.push(playerId);
    const player = importedPlayers.get(playerId);
    if (!player) throw new Error(`mutatePlayer (fixture) : joueur "${playerId}" introuvable -- ensurePlayerExists jamais appele avant`);
    await mutator(player);
    return player;
  }) as unknown as JsonPlayerImportDeps["mutatePlayer"];

  return { getPlayer, ensurePlayerExists, mutatePlayer, getPlayerCalls, ensurePlayerExistsCalls, mutatePlayerCalls, importedPlayers };
}

test("importJsonPlayers -- joueur absent de Postgres -> importe avec TOUTES ses valeurs JSON (coins/xp/level/plots/inventaire/ameliorations/quests/skin/autoReplant/forecast/weekly)", async () => {
  const jsonPlayer = buildJsonPlayer();
  const deps = buildDeps();

  const summary = await importJsonPlayers([jsonPlayer], { dryRun: false }, deps);

  assert.equal(summary.totalJsonPlayers, 1);
  assert.equal(summary.alreadyInPostgres, 0);
  assert.equal(summary.imported, 1);
  assert.equal(deps.ensurePlayerExistsCalls.length, 1);
  assert.equal(deps.mutatePlayerCalls.length, 1);

  const imported = deps.importedPlayers.get(jsonPlayer.userId)!;
  assert.equal(imported.coins, 342);
  assert.equal(imported.level, 4);
  assert.equal(imported.xp, 17);
  assert.equal(imported.plots[0]!.cropId, "wheat");
  assert.deepEqual(imported.inventory, { wheat: 6, carrot: 2 });
  assert.equal(imported.irrigationLevel, 2);
  assert.equal(imported.fertilizerLevel, 1);
  assert.equal(imported.autoReplant, true);
  assert.equal(imported.weeklySnapshotCoins, 300);
  assert.equal(imported.totalHarvested, 25);
});

test("importJsonPlayers -- joueur DEJA present dans Postgres -> SKIP, jamais ecrase (ensurePlayerExists/mutatePlayer jamais appeles pour lui)", async () => {
  const jsonPlayer = buildJsonPlayer({ userId: "already-migrated-player" });
  const deps = buildDeps(new Set(["already-migrated-player"]));

  const summary = await importJsonPlayers([jsonPlayer], { dryRun: false }, deps);

  assert.equal(summary.alreadyInPostgres, 1);
  assert.equal(summary.imported, 0);
  assert.equal(deps.ensurePlayerExistsCalls.length, 0, "ne doit JAMAIS toucher un joueur deja present en Postgres");
  assert.equal(deps.mutatePlayerCalls.length, 0);
});

test("importJsonPlayers -- dry-run : compte sans jamais ecrire (aucun appel a ensurePlayerExists/mutatePlayer)", async () => {
  const jsonPlayers = [
    buildJsonPlayer({ userId: "dry-run-new-1" }),
    buildJsonPlayer({ userId: "dry-run-new-2" }),
    buildJsonPlayer({ userId: "dry-run-existing" }),
  ];
  const deps = buildDeps(new Set(["dry-run-existing"]));

  const summary = await importJsonPlayers(jsonPlayers, { dryRun: true }, deps);

  assert.equal(summary.totalJsonPlayers, 3);
  assert.equal(summary.alreadyInPostgres, 1);
  assert.equal(summary.wouldImport, 2);
  assert.equal(summary.imported, 0, "dry-run ne doit jamais reellement importer");
  assert.equal(deps.ensurePlayerExistsCalls.length, 0, "dry-run ne doit JAMAIS ecrire");
  assert.equal(deps.mutatePlayerCalls.length, 0);
});

test("importJsonPlayers -- idempotent : relancer l'import apres un premier import reussi ne re-importe pas / n'ecrase pas", async () => {
  const jsonPlayer = buildJsonPlayer({ userId: "idempotent-player", coins: 999 });
  const deps = buildDeps();

  const firstRun = await importJsonPlayers([jsonPlayer], { dryRun: false }, deps);
  assert.equal(firstRun.imported, 1);

  // Second passage : simule que le joueur existe maintenant reellement en
  // Postgres (comme il le ferait apres le premier import reel).
  const secondRunDeps: JsonPlayerImportDeps = {
    ...deps,
    getPlayer: mock.fn(async (playerId: string) =>
      playerId === jsonPlayer.userId ? deps.importedPlayers.get(playerId)! : null,
    ) as unknown as JsonPlayerImportDeps["getPlayer"],
  };
  const secondRun = await importJsonPlayers([jsonPlayer], { dryRun: false }, secondRunDeps);

  assert.equal(secondRun.alreadyInPostgres, 1);
  assert.equal(secondRun.imported, 0, "un second passage ne doit jamais re-importer/ecraser un joueur deja migre");
});

test("importJsonPlayers -- plusieurs joueurs : un joueur deja present et un joueur absent sont traites independamment dans le meme lot", async () => {
  const jsonPlayers = [
    buildJsonPlayer({ userId: "batch-existing" }),
    buildJsonPlayer({ userId: "batch-new", coins: 77 }),
  ];
  const deps = buildDeps(new Set(["batch-existing"]));

  const summary = await importJsonPlayers(jsonPlayers, { dryRun: false }, deps);

  assert.equal(summary.alreadyInPostgres, 1);
  assert.equal(summary.imported, 1);
  assert.equal(deps.importedPlayers.get("batch-new")!.coins, 77);
  assert.equal(deps.importedPlayers.has("batch-existing"), false, "le joueur deja existant n'est jamais passe a ensurePlayerExists/mutatePlayer");
});

test("importJsonPlayers -- detecte une incompatibilite (culture/theme inconnu) SANS bloquer l'import et SANS exposer le Discord ID complet", async () => {
  const jsonPlayer = buildJsonPlayer({
    userId: "incompatible-player-123456789",
    plots: [{ cropId: "unobtainium" as never, plantedAt: NOW, notifiedReady: false }],
    plotSkin: "holographic" as never,
  });
  const deps = buildDeps();

  const summary = await importJsonPlayers([jsonPlayer], { dryRun: false }, deps);

  assert.equal(summary.imported, 1, "une incompatibilite signale, mais n'empeche pas l'import du reste des donnees");
  assert.ok(summary.incompatibilities.length >= 2, "culture inconnue ET theme inconnu doivent etre tous deux signales");
  for (const issue of summary.incompatibilities) {
    assert.equal(issue.includes("incompatible-player-123456789"), false, "le rapport ne doit JAMAIS contenir le Discord ID complet");
    assert.ok(issue.includes("joueur #0"), "le rapport identifie le joueur par INDEX dans le lot, jamais par ID");
  }
});

test("importJsonPlayers -- lot vide -> aucune action, resume a zero partout", async () => {
  const deps = buildDeps();
  const summary = await importJsonPlayers([], { dryRun: false }, deps);

  assert.equal(summary.totalJsonPlayers, 0);
  assert.equal(summary.alreadyInPostgres, 0);
  assert.equal(summary.imported, 0);
  assert.equal(summary.wouldImport, 0);
  assert.deepEqual(summary.incompatibilities, []);
});
