// Seul endroit ou un DTO PostgreSQL/Drizzle (@workspace/db) est converti en
// PlayerState (le type metier V1). C'est aussi le seul endroit ou les
// valeurs texte libres issues de Postgres (crop_id, item_id, plot_skin,
// weather_forecast, quests[].type...) sont affirmees vers les unions
// strictes du domaine (CropId, PlotSkinId, WeatherKey, QuestType) -- Postgres
// ne garantit pas ces unions (simples colonnes text/jsonb), ce cast est une
// frontiere DB -> domaine assumee, pas un contournement de type.
import type { PlayerRecord } from "@workspace/db/repositories";
import type {
  CropId,
  InventoryId,
  PlayerState,
  Plot,
  PlotSkinId,
  QuestProgress,
  WeatherKey,
} from "../types";

export function toPlayerState(record: PlayerRecord): PlayerState {
  const { player, plots: plotRows, inventoryItems: inventoryRows } = record;

  const plots: Plot[] = plotRows.map((row) => ({
    cropId: row.cropId as CropId | null,
    plantedAt: row.plantedAt ? row.plantedAt.getTime() : null,
    notifiedReady: row.notifiedReady,
  }));

  const inventory: Partial<Record<InventoryId, number>> = {};
  for (const row of inventoryRows) {
    inventory[row.itemId as InventoryId] = row.quantity;
  }

  return {
    userId: player.id,
    coins: player.coins,
    level: player.level,
    xp: player.xp,
    plots,
    inventory,
    irrigationLevel: player.irrigationLevel,
    fertilizerLevel: player.fertilizerLevel,
    lastDailyAt: player.lastDailyAt ? player.lastDailyAt.getTime() : null,
    autoReplant: player.autoReplant,
    weeklySnapshotCoins: player.weeklySnapshotCoins,
    createdAt: player.createdAt.getTime(),
    updatedAt: player.updatedAt.getTime(),
    totalHarvested: player.totalHarvested,
    quests: player.quests as QuestProgress[],
    questsResetAt: player.questsResetAt.getTime(),
    plotSkin: player.plotSkin as PlotSkinId,
    unlockedSkins: player.unlockedSkins as PlotSkinId[],
    weatherForecast: player.weatherForecast as WeatherKey | null,
  };
}
