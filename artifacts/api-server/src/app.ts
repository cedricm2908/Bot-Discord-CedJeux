import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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

// LOT A -- page de test minimale prouvant que Railway peut servir
// directement le frontend Discord Activity sur /activity, SANS
// redirection (contrairement au comportement par defaut de
// express.static, qui redirigerait /activity vers /activity/ -- voir
// l'audit d'architecture Railway-only). Les deux chemins repondent
// directement au meme contenu, jamais de header Location. Remplacee par
// le vrai build farm2win-activity dans un lot ulterieur.
const ACTIVITY_TEST_PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Farm2Win Activity Test</title>
</head>
<body>
<h1>FARM2WIN RAILWAY ACTIVITY TEST</h1>
<p>Railway Activity Test</p>
<p>Frontend servi directement depuis Railway.</p>
</body>
</html>`;

app.get(["/activity", "/activity/"], (_req, res) => {
  res.type("html").send(ACTIVITY_TEST_PAGE_HTML);
});

app.use("/api", router);

export default app;
