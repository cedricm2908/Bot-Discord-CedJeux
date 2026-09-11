// LOT ACTIVITY-CACHE -- verifie que le frontend Activity ne peut plus
// rester bloque sur une ancienne version cote Discord/proxy.
//
// Aucune connexion Neon/Railway : `configureActivityStatic()` est testee
// contre un repertoire de FIXTURE (pas le vrai dist-static/activity, qui
// n'existe que apres un vrai `vite build` -- indisponible dans ce sandbox,
// voir le rapport final du LOT) simulant exactement ce que build.mjs
// produit reellement : index.html + assets/<nom>-<hash>.js.
//
// configureActivityStatic() vit dans son propre module (activityStatic.ts,
// aucune dependance a routes/index.ts/health.ts/@workspace/api-zod) --
// importer app.ts directement ici tirerait toute cette chaine non liee au
// cache frontend dans ce test, et exposerait des problemes de resolution
// de modules totalement hors sujet.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http, { type Server } from "node:http";
import express, { type Express } from "express";
import { configureActivityStatic } from "./activityStatic.ts";

async function buildFixtureStaticDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "activity-static-"));
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(
    path.join(dir, "index.html"),
    '<!doctype html><html><body><script type="module" src="./assets/main-f00dcafe.js"></script></body></html>',
  );
  await writeFile(
    path.join(dir, "assets", "main-f00dcafe.js"),
    "console.log('Changement météo dans');",
  );
  return dir;
}

async function startApp(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("startApp : impossible de determiner le port attribue");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("configureActivityStatic -- GET /activity retourne 200 directement, AUCUNE redirection 301/302", async () => {
  const staticDir = await buildFixtureStaticDir();
  const app = express();
  configureActivityStatic(app, staticDir);
  const { server, baseUrl } = await startApp(app);

  try {
    const res = await fetch(`${baseUrl}/activity`, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.ok(!res.headers.has("location"), "aucune redirection ne doit avoir lieu");
    const body = await res.text();
    assert.ok(body.includes("assets/main-f00dcafe.js"), "index.html doit referencer le fichier hashe genere par le build, sans query param ?v= manuel");
    assert.ok(!body.includes("?v="), "plus aucun cache-buster manuel (?v=16, etc.)");
  } finally {
    server.close();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test("configureActivityStatic -- GET /activity/ retourne aussi 200 directement", async () => {
  const staticDir = await buildFixtureStaticDir();
  const app = express();
  configureActivityStatic(app, staticDir);
  const { server, baseUrl } = await startApp(app);

  try {
    const res = await fetch(`${baseUrl}/activity/`, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.ok(!res.headers.has("location"));
  } finally {
    server.close();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test("configureActivityStatic -- index.html est servi avec Cache-Control: no-store (jamais reutilise apres un deploiement)", async () => {
  const staticDir = await buildFixtureStaticDir();
  const app = express();
  configureActivityStatic(app, staticDir);
  const { server, baseUrl } = await startApp(app);

  try {
    const res = await fetch(`${baseUrl}/activity`);
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    server.close();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test("configureActivityStatic -- un asset sous assets/ (nom hashe) est servi avec un cache long et immuable", async () => {
  const staticDir = await buildFixtureStaticDir();
  const app = express();
  configureActivityStatic(app, staticDir);
  const { server, baseUrl } = await startApp(app);

  try {
    const res = await fetch(`${baseUrl}/activity/assets/main-f00dcafe.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const body = await res.text();
    assert.ok(body.includes("Changement météo dans"), "l'asset servi doit bien correspondre au contenu du build courant");
  } finally {
    server.close();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test("configureActivityStatic -- ne touche a aucune route montee a cote (aucun Cache-Control ajoute en dehors de /activity, /api/* non affecte)", async () => {
  const staticDir = await buildFixtureStaticDir();
  const app = express();
  configureActivityStatic(app, staticDir);
  // Simule une route API montee a cote, exactement comme app.ts monte
  // app.use("/api", router) apres configureActivityStatic() -- verifie que
  // ce LOT n'ajoute aucun Cache-Control en dehors de /activity.
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  const { server, baseUrl } = await startApp(app);

  try {
    const res = await fetch(`${baseUrl}/api/ping`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), null, "aucun Cache-Control ne doit etre ajoute par configureActivityStatic() sur une route hors /activity");
  } finally {
    server.close();
    await rm(staticDir, { recursive: true, force: true });
  }
});
