import { defineConfig } from "drizzle-kit";
import path from "path";

// `generate` ne se connecte jamais a une base (simple diff de schema en SQL) :
// il n'a donc pas besoin d'un DATABASE_URL reel. `push`/`migrate` en ont
// besoin pour de vrai, mais c'est a l'appelant de fournir un DATABASE_URL
// reel dans ces cas-la -- sans lui, la connexion echouera naturellement
// (ex. ECONNREFUSED sur localhost), sans jamais toucher de vraie base.
const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://generate-only:unused@localhost:5432/unused";

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: path.join(__dirname, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
