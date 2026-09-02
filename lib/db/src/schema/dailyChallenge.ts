import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Modele historique (option B validee) : chaque defi quotidien est une
// nouvelle ligne. Le defi "actuel" est celui avec le started_at le plus
// recent — aucune colonne "is_current" necessaire pour un seul defi actif
// a la fois, mais le service V2 doit toujours resoudre "le defi courant"
// par ORDER BY started_at DESC LIMIT 1 (ou equivalent), jamais par un id fixe.
export const dailyChallenge = pgTable(
  "daily_challenge",
  {
    id: serial("id").primaryKey(),
    cropId: text("crop_id").notNull(),
    target: integer("target").notNull(),
    progress: integer("progress").notNull().default(0),
    rewardCoins: integer("reward_coins").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completed: boolean("completed").notNull().default(false),
    rewarded: boolean("rewarded").notNull().default(false),
  },
  (table) => [
    check("daily_challenge_target_positive", sql`${table.target} > 0`),
    check("daily_challenge_progress_non_negative", sql`${table.progress} >= 0`),
    check("daily_challenge_reward_coins_non_negative", sql`${table.rewardCoins} >= 0`),
    // Un defi non termine ne peut pas etre marque "recompense" (coherence d'etat).
    check(
      "daily_challenge_rewarded_implies_completed",
      sql`${table.rewarded} = false OR ${table.completed} = true`,
    ),
  ],
);

export type DailyChallengeRow = typeof dailyChallenge.$inferSelect;
export type NewDailyChallengeRow = typeof dailyChallenge.$inferInsert;
