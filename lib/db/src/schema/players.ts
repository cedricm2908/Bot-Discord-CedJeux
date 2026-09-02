import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const players = pgTable(
  "players",
  {
    // Identifiant Discord (snowflake), jamais genere par la base.
    id: text("id").primaryKey(),
    coins: integer("coins").notNull().default(50),
    level: integer("level").notNull().default(1),
    xp: integer("xp").notNull().default(0),
    irrigationLevel: integer("irrigation_level").notNull().default(0),
    fertilizerLevel: integer("fertilizer_level").notNull().default(0),
    lastDailyAt: timestamp("last_daily_at", { withTimezone: true }),
    autoReplant: boolean("auto_replant").notNull().default(false),
    weeklySnapshotCoins: integer("weekly_snapshot_coins").notNull().default(50),
    totalHarvested: integer("total_harvested").notNull().default(0),
    // Missions quotidiennes : toujours remplacees en bloc (jamais interrogees
    // individuellement entre joueurs) -> JSONB, decision D1 validee.
    quests: jsonb("quests").notNull().default(sql`'[]'::jsonb`),
    questsResetAt: timestamp("quests_reset_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    plotSkin: text("plot_skin").notNull().default("classic"),
    // Skins definitivement debloques. Choix fait pour cette etape (a
    // confirmer/ajuster si besoin) : colonne tableau dediee plutot que du
    // JSONB, car ce n'est pas mentionne dans la decision D1 et ce n'est pas
    // une donnee sensible a la concurrence (elle ne fait que grandir).
    unlockedSkins: text("unlocked_skins")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    weatherForecast: text("weather_forecast"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("players_coins_non_negative", sql`${table.coins} >= 0`),
    check("players_xp_non_negative", sql`${table.xp} >= 0`),
    check("players_level_positive", sql`${table.level} >= 1`),
    check(
      "players_irrigation_level_non_negative",
      sql`${table.irrigationLevel} >= 0`,
    ),
    check(
      "players_fertilizer_level_non_negative",
      sql`${table.fertilizerLevel} >= 0`,
    ),
    check(
      "players_total_harvested_non_negative",
      sql`${table.totalHarvested} >= 0`,
    ),
    check(
      "players_weekly_snapshot_coins_non_negative",
      sql`${table.weeklySnapshotCoins} >= 0`,
    ),
  ],
);

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
