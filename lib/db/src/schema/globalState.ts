import { sql } from "drizzle-orm";
import { check, doublePrecision, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const globalState = pgTable(
  "global_state",
  {
    // Ligne singleton : toujours id = 1, jamais d'insertion supplementaire.
    id: integer("id").primaryKey().default(1),
    marketMultiplier: doublePrecision("market_multiplier").notNull().default(1),
    previousMarketMultiplier: doublePrecision("previous_market_multiplier")
      .notNull()
      .default(1),
    marketUpdatedAt: timestamp("market_updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    weather: text("weather").notNull().default("normal"),
    weatherMultiplier: doublePrecision("weather_multiplier").notNull().default(1),
    weatherChangedAt: timestamp("weather_changed_at", { withTimezone: true }),
    weatherExpiresAt: timestamp("weather_expires_at", { withTimezone: true }),
    nextWeatherAt: timestamp("next_weather_at", { withTimezone: true }).notNull(),
    nextWeatherType: text("next_weather_type").notNull().default("rain"),
    weeklyStartedAt: timestamp("weekly_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("global_state_singleton", sql`${table.id} = 1`),
    // Bornes reprises telles quelles de la logique V1 (Math.min(1.4, Math.max(0.65, ...))).
    check(
      "global_state_market_multiplier_range",
      sql`${table.marketMultiplier} >= 0.65 AND ${table.marketMultiplier} <= 1.4`,
    ),
    check(
      "global_state_weather_multiplier_positive",
      sql`${table.weatherMultiplier} > 0`,
    ),
  ],
);

export type GlobalStateRow = typeof globalState.$inferSelect;
export type NewGlobalStateRow = typeof globalState.$inferInsert;
