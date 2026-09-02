// Applique les migrations Drizzle versionnees (lib/db/drizzle/*) a la base
// PostgreSQL pointee par DATABASE_URL. N'utilise jamais `drizzle-kit push` :
// uniquement des fichiers de migration generes et commites au prealable.
//
// Ce script ne fait rien d'autre que lire DATABASE_URL depuis l'environnement,
// appliquer les migrations, puis fermer proprement la connexion. Il n'affiche
// jamais la valeur de DATABASE_URL, seulement le fait qu'elle est presente ou non.
//
// Usage prevu (Railway, jamais depuis un poste Windows local) :
//   pnpm --filter @workspace/db run migrate
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "[migrate] DATABASE_URL est absente de l'environnement. Migration annulee.",
  );
  process.exit(1);
}

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

async function run(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool);
    console.log(`[migrate] Application des migrations depuis ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    console.log("[migrate] Migrations appliquees avec succes.");
  } finally {
    await pool.end();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(
      "[migrate] Echec de la migration :",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
