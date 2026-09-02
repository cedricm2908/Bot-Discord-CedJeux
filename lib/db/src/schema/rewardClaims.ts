import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { players } from "./players";

// Journal d'idempotence pour toute action qui accorde une recompense
// (daily, quete, weekly, defi du jour...). C'est la contrainte unique
// (player_id, claim_type) qui garantit "jamais deux fois", pas une
// simple comparaison de timestamp en memoire comme en V1.
//
// Convention pour claim_type : encoder la periode dans la valeur pour
// les recompenses periodiques, ex. "daily:2026-09-02", "weekly:2026-W36",
// "quest:harvest:2026-09-02". Pour une recompense qui n'arrive qu'une
// seule fois dans la vie du joueur, un type fixe suffit.
export const rewardClaims = pgTable(
  "reward_claims",
  {
    id: serial("id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    claimType: text("claim_type").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("reward_claims_player_id_claim_type_unique").on(
      table.playerId,
      table.claimType,
    ),
  ],
);

export type RewardClaim = typeof rewardClaims.$inferSelect;
export type NewRewardClaim = typeof rewardClaims.$inferInsert;
