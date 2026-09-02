import { sql } from "drizzle-orm";
import { check, doublePrecision, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const contract = pgTable(
  "contract",
  {
    // Ligne singleton : toujours id = 1, remplacee (UPDATE) a chaque renouvellement.
    id: integer("id").primaryKey().default(1),
    cropId: text("crop_id").notNull(),
    required: integer("required").notNull(),
    remaining: integer("remaining").notNull(),
    bonusMultiplier: doublePrecision("bonus_multiplier").notNull(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("contract_singleton", sql`${table.id} = 1`),
    check("contract_required_positive", sql`${table.required} > 0`),
    check("contract_remaining_non_negative", sql`${table.remaining} >= 0`),
    check("contract_remaining_le_required", sql`${table.remaining} <= ${table.required}`),
    check("contract_bonus_multiplier_positive", sql`${table.bonusMultiplier} > 0`),
  ],
);

export type ContractRow = typeof contract.$inferSelect;
export type NewContractRow = typeof contract.$inferInsert;
