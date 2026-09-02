import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { players } from "./players";

export const plots = pgTable(
  "plots",
  {
    id: serial("id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    // Index 0-based de la parcelle, identique a l'index du tableau plots[]
    // cote V1 (pas de decalage a gerer lors de la migration).
    plotIndex: integer("plot_index").notNull(),
    cropId: text("crop_id"),
    plantedAt: timestamp("planted_at", { withTimezone: true }),
    notifiedReady: boolean("notified_ready").notNull().default(false),
  },
  (table) => [
    unique("plots_player_id_plot_index_unique").on(
      table.playerId,
      table.plotIndex,
    ),
    check("plots_plot_index_non_negative", sql`${table.plotIndex} >= 0`),
  ],
);

export type Plot = typeof plots.$inferSelect;
export type NewPlot = typeof plots.$inferInsert;
