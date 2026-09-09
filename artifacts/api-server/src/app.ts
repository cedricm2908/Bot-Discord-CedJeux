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

app.use("/api", router);

export default app;
