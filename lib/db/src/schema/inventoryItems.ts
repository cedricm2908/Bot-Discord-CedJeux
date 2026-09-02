import { sql } from "drizzle-orm";
import { check, integer, pgTable, serial, text, unique } from "drizzle-orm/pg-core";
import { players } from "./players";

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: serial("id").primaryKey(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    // Identifiant de culture ou de produit transforme (CropId | ProductId cote V1).
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull().default(0),
  },
  (table) => [
    unique("inventory_items_player_id_item_id_unique").on(
      table.playerId,
      table.itemId,
    ),
    check("inventory_items_quantity_non_negative", sql`${table.quantity} >= 0`),
  ],
);

export type InventoryItem = typeof inventoryItems.$inferSelect;
export type NewInventoryItem = typeof inventoryItems.$inferInsert;
