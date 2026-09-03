// Repository EN LECTURE SEULE. Ne connait que PostgreSQL/Drizzle : retourne
// des DTO bruts (types inferes directement du schema), jamais une forme
// "domaine" (PlayerState). La conversion vers PlayerState est la
// responsabilite exclusive des adaptateurs cote api-server
// (artifacts/api-server/src/discord/db/playerAdapter.ts).
//
// getPlayerRecord() retourne `null` si aucune ligne n'existe pour cet id --
// a la couche appelante de decider quoi faire de cette absence (V1 auto-
// cree un joueur par defaut, mais l'auto-creation est une ECRITURE qui
// n'appartient pas a ce repository).
import { asc, eq } from "drizzle-orm";
import { db } from "../index";
import { inventoryItems, players, plots } from "../schema";
import type { InventoryItem, Player, Plot } from "../schema";

export interface PlayerRecord {
  player: Player;
  plots: Plot[];
  inventoryItems: InventoryItem[];
}

export async function getPlayerRecord(userId: string): Promise<PlayerRecord | null> {
  const [playerRow] = await db
    .select()
    .from(players)
    .where(eq(players.id, userId))
    .limit(1);
  if (!playerRow) return null;

  const plotRows = await db
    .select()
    .from(plots)
    .where(eq(plots.playerId, userId))
    .orderBy(asc(plots.plotIndex));

  const inventoryRows = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.playerId, userId));

  return { player: playerRow, plots: plotRows, inventoryItems: inventoryRows };
}

// Simple pour l'instant (une requete par joueur via getPlayerRecord) --
// optimisation N+1 explicitement reportee a plus tard.
export async function getAllPlayerRecords(): Promise<PlayerRecord[]> {
  const playerRows = await db.select().from(players);
  const results: PlayerRecord[] = [];
  for (const row of playerRows) {
    const record = await getPlayerRecord(row.id);
    if (record) results.push(record);
  }
  return results;
}
