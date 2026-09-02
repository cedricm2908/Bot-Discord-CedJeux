import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { dailyChallenge } from "./dailyChallenge";
import { players } from "./players";

// Remplace le tableau contributors: string[] de la V1. L'insertion avec
// ON CONFLICT DO NOTHING (cote service) rend "a deja contribue a CE defi"
// atomique et idempotent. Pas de purge au reset (option B) : une ligne
// reste rattachee pour toujours a son challenge_id d'origine.
export const dailyChallengeContributors = pgTable(
  "daily_challenge_contributors",
  {
    challengeId: integer("challenge_id")
      .notNull()
      .references(() => dailyChallenge.id, { onDelete: "cascade" }),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    contributedAt: timestamp("contributed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.challengeId, table.playerId] }),
  ],
);

export type DailyChallengeContributor = typeof dailyChallengeContributors.$inferSelect;
export type NewDailyChallengeContributor = typeof dailyChallengeContributors.$inferInsert;
