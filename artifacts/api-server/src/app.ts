import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import router from "./routes/index.ts";
import { logger } from "./lib/logger.ts";
import { configureActivityStatic } from "./activityStatic.ts";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
    // DIAGNOSTIC TEMPORAIRE (a retirer une fois l'Activity validee en
    // reel) : Railway n'affiche pas les champs structures req/res
    // ci-dessus, seulement le texte du message ("request completed") --
    // meme raison que le diagnostic /harvest precedent. method/path/status
    // inclus directement dans le TEXTE du log, jamais de query string
    // (deja retiree via split("?")[0], meme convention que serializers.req
    // ci-dessus), jamais de body/Authorization/token/playerId/secret.
    customSuccessMessage: (req, res) =>
      `${req.method} ${req.url?.split("?")[0]} -> ${res.statusCode}`,
    customErrorMessage: (req, res) =>
      `${req.method} ${req.url?.split("?")[0]} -> ${res.statusCode}`,
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// LOT B -- sert le vrai frontend Farm2Win Activity (artifacts/activity-frontend),
// buildé séparément puis copié par build.mjs vers dist-static/activity/, un
// répertoire FRÈRE du bundle dist/index.mjs (jamais dedans). Résolu depuis
// import.meta.url (jamais process.cwd(), instable selon le contexte de
// lancement) pour fonctionner identiquement en local et sur Railway.
// Logique de routage/cache extraite dans activityStatic.ts (LOT
// ACTIVITY-CACHE) -- voir ce fichier pour le detail des en-tetes Cache-Control.
const activityStaticDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist-static/activity",
);
configureActivityStatic(app, activityStaticDir);

app.use("/api", router);

export default app;
