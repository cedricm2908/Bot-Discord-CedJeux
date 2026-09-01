# CedJeux · Bot Discord Farm2Win

Bot Discord en TypeScript qui propose le mini-jeu agricole Farm2Win avec économie, marché, météo, contrats et classement.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret for Discord connection: `DISCORD_TOKEN`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/discord/constants.ts` — cultures, recettes, paliers et configuration du jeu
- `artifacts/api-server/src/discord/farm.ts` — règles économiques, récoltes, achats, crafting et récompenses
- `artifacts/api-server/src/discord/store.ts` — sauvegarde JSON persistante des joueurs
- `artifacts/api-server/src/discord/presenters.ts` — commandes slash, embeds et panneau Codex
- `artifacts/api-server/src/discord/bot.ts` — connexion Discord, enregistrement des commandes et tâches récurrentes
- `data/farm2win.json` — données créées au premier démarrage (non versionnées)

## Architecture decisions

- Le bot partage le processus du serveur API pour utiliser le workflow existant et garder un seul point de démarrage.
- Les données Farm2Win sont stockées dans un fichier JSON atomiquement remplacé, adapté à un bot unique et simple à sauvegarder.
- Les slash commands sont enregistrées globalement à chaque démarrage pour rester synchronisées avec le code.
- Le panneau Codex met à jour le même message après chaque interaction de composant.

## Product

Les joueurs cultivent, récoltent, transforment et vendent des ressources, améliorent leur ferme, suivent la météo et les contrats, puis se disputent les classements richesse et hebdomadaire.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
