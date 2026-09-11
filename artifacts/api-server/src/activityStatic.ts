import express, { type Express } from "express";
import path from "node:path";

// LOT B -- sert le vrai frontend Farm2Win Activity (artifacts/activity-frontend),
// buildé séparément puis copié par build.mjs vers dist-static/activity/, un
// répertoire FRÈRE du bundle dist/index.mjs (jamais dedans). Résolu depuis
// import.meta.url (jamais process.cwd(), instable selon le contexte de
// lancement) pour fonctionner identiquement en local et sur Railway.
// Route explicite pour /activity et /activity/ AVANT le middleware static,
// garantissant zéro redirection 301/302 quel que soit le comportement de
// express.static pour un chemin sans slash final -- voir l'audit
// d'architecture Railway-only. Remplace la page de test du LOT A.
//
// LOT ACTIVITY-CACHE -- module dédié (aucune dépendance à routes/index.ts,
// health.ts ou @workspace/api-zod) uniquement pour rester testable de
// façon totalement isolée, contre un répertoire de fixture, sans jamais
// nécessiter dist-static/activity (qui n'existe que après un vrai build
// frontend, indisponible dans ce sandbox) ni tirer dans les tests une
// chaîne d'imports sans rapport avec le cache Activity. Le comportement de
// production (appelé depuis app.ts avec le VRAI chemin resolu) est inchangé.
//
// index.html doit TOUJOURS être re-récupéré après un déploiement (il
// référence le nom de fichier hashé du JS courant, généré par vite build --
// voir vite.config.js) : sans en-tête explicite, express/`send` retombe
// sur son défaut "Cache-Control: public, max-age=0" (revalidation
// seulement, PAS un vrai rechargement garanti -- un proxy/cache
// intermédiaire qui ignore la revalidation peut resservir une ancienne
// page indéfiniment, exactement le symptôme observé côté Discord).
// no-store est sans ambiguïté : jamais réutilisé, jamais mis en cache, ne
// concerne QUE /activity et /activity/ (index.html), jamais les routes
// /api/*.
//
// Les fichiers sous assets/ portent un hash de CONTENU dans leur nom
// (vite.config.js) : un changement de code produit une URL différente,
// donc un cache long et immuable ne peut jamais servir un JS/CSS périmé --
// l'inverse d'index.html ci-dessus, qui doit rester no-store puisque son
// propre nom ne change jamais. Tout fichier hors de assets/ (aucun
// attendu en usage normal, le seul non-hashé étant index.html déjà servi
// par la route explicite ci-dessous) retombe sur no-store par prudence --
// fiabilité avant optimisation du cache.
export function configureActivityStatic(targetApp: Express, activityStaticDir: string): void {
  const activityIndexHtmlPath = path.join(activityStaticDir, "index.html");

  targetApp.get(["/activity", "/activity/"], (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(activityIndexHtmlPath);
  });
  targetApp.use(
    "/activity",
    express.static(activityStaticDir, {
      redirect: false,
      setHeaders(res, filePath) {
        const isHashedAsset = path.relative(activityStaticDir, filePath).startsWith(`assets${path.sep}`);
        res.set(
          "Cache-Control",
          isHashedAsset ? "public, max-age=31536000, immutable" : "no-store",
        );
      },
    }),
  );
}
