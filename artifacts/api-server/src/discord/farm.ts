import {
  CONTRACT_INTERVAL_MS,
  CROPS,
  DAILY_COOLDOWN_MS,
  MAX_FERTILIZER,
  MAX_IRRIGATION,
  MAX_PLOTS,
  MARKET_INTERVAL_MS,
  RECIPES,
  STARTING_PLOTS,
  WEEKLY_INTERVAL_MS,
  WEATHER_INFO,
  cropById,
  randomBetween,
  recipeById,
} from "./constants";
import type {
  CropId,
  GlobalState,
  InventoryId,
  PlayerState,
  ProductId,
  WeatherKey,
} from "./types";
import { FarmStore } from "./store";

export class FarmError extends Error {}

export interface HarvestResult {
  harvested: Array<{ cropId: CropId; amount: number; xp: number; replanted: boolean }>;
  totalXp: number;
  leveledUpTo: number;
}

export interface SellResult {
  sold: Array<{ itemId: InventoryId; amount: number; earned: number }>;
  earned: number;
}

export function xpToNextLevel(level: number): number {
  return Math.round(50 * level ** 1.5) + 50;
}

export function growMinutes(player: PlayerState, cropId: CropId): number {
  const crop = cropById(cropId);
  return crop.growMinutes * (1 - Math.min(0.45, player.irrigationLevel * 0.03));
}

export function isReady(player: PlayerState, plotIndex: number, now = Date.now()): boolean {
  const plot = player.plots[plotIndex];
  if (!plot?.cropId || plot.plantedAt === null) return false;
  return now >= plot.plantedAt + growMinutes(player, plot.cropId) * 60 * 1000;
}

export function growthPercent(player: PlayerState, plotIndex: number, now = Date.now()): number {
  const plot = player.plots[plotIndex];
  if (!plot?.cropId || plot.plantedAt === null) return 0;
  const duration = growMinutes(player, plot.cropId) * 60 * 1000;
  return Math.min(100, Math.max(0, Math.floor(((now - plot.plantedAt) / duration) * 100)));
}

export function currentCropPrice(global: GlobalState, cropId: CropId): number {
  return Math.max(1, Math.round(cropById(cropId).basePrice * global.marketMultiplier));
}

export function productPrice(itemId: ProductId): number {
  return recipeById(itemId).sellPrice;
}

export function totalInventoryValue(
  player: PlayerState,
  global: GlobalState,
): number {
  return Object.entries(player.inventory).reduce((total, [itemId, amount]) => {
    if (!amount) return total;
    const crop = CROPS.find((candidate) => candidate.id === itemId);
    return total + amount * (crop ? currentCropPrice(global, crop.id) : productPrice(itemId as ProductId));
  }, 0);
}

export function enrichGlobalState(global: GlobalState, now = Date.now()): boolean {
  let changed = false;
  if (now - global.marketUpdatedAt >= MARKET_INTERVAL_MS) {
    const variation = (Math.random() * 0.32 - 0.16);
    global.previousMarketMultiplier = global.marketMultiplier;
    global.marketMultiplier = Math.min(
      1.4,
      Math.max(0.65, global.marketMultiplier + variation),
    );
    global.marketUpdatedAt = now;
    changed = true;
  }

  if (now >= global.nextWeatherAt) {
    const weather: WeatherKey = Math.random() < 0.5 ? "rain" : "pests";
    global.weather = weather;
    global.weatherMultiplier = WEATHER_INFO[weather].multiplier;
    global.weatherChangedAt = now;
    global.weatherExpiresAt =
      now + randomBetween(30 * 60 * 1000, 60 * 60 * 1000);
    global.nextWeatherAt = global.weatherExpiresAt;
    changed = true;
  } else if (
    global.weather !== "normal" &&
    global.weatherChangedAt !== null &&
    global.weatherExpiresAt !== null &&
    now >= global.weatherExpiresAt
  ) {
    global.weather = "normal";
    global.weatherMultiplier = 1;
    global.weatherChangedAt = null;
    global.weatherExpiresAt = null;
    global.nextWeatherAt =
      now + randomBetween(2 * 60 * 60 * 1000, 4 * 60 * 60 * 1000);
    changed = true;
  }

  if (now - global.contract.renewedAt >= CONTRACT_INTERVAL_MS) {
    const availableCrops = CROPS.filter((candidate) => candidate.unlockLevel <= 20);
    const crop = availableCrops[randomBetween(0, availableCrops.length - 1)];
    const required = randomBetween(20, 60);
    global.contract = {
      cropId: crop.id,
      required,
      remaining: required,
      bonusMultiplier: Number((1.6 + Math.random() * 0.4).toFixed(2)),
      renewedAt: now,
    };
    changed = true;
  }

  return changed;
}

export function resetWeeklyIfNeeded(store: FarmStore, now = Date.now()): boolean {
  const global = store.global;
  if (now - global.weeklyStartedAt < WEEKLY_INTERVAL_MS) return false;
  const top = [...store.getPlayers()]
    .sort((a, b) => b.coins - b.weeklySnapshotCoins - (a.coins - a.weeklySnapshotCoins))
    .slice(0, 3);
  const rewards = [500, 300, 150];
  top.forEach((player, index) => {
    player.coins += rewards[index] ?? 0;
  });
  for (const player of store.getPlayers()) {
    player.weeklySnapshotCoins = player.coins;
    player.updatedAt = now;
  }
  global.weeklyStartedAt = now;
  return true;
}

export function assertCropUnlocked(player: PlayerState, cropId: CropId): void {
  const crop = cropById(cropId);
  if (player.level < crop.unlockLevel) {
    throw new FarmError(`Cette culture se débloque au niveau ${crop.unlockLevel}.`);
  }
}

export function plant(
  player: PlayerState,
  cropId: CropId,
  requestedPlot: number | null,
  now = Date.now(),
): number {
  const crop = cropById(cropId);
  assertCropUnlocked(player, cropId);
  if (player.coins < crop.seedCost) {
    throw new FarmError(`Il te faut ${crop.seedCost} pièces pour acheter cette graine.`);
  }
  const index =
    requestedPlot === null
      ? player.plots.findIndex((plot) => plot.cropId === null)
      : requestedPlot - 1;
  if (index < 0 || index >= player.plots.length) {
    throw new FarmError(`Cette parcelle n'existe pas. Choisis un numéro entre 1 et ${player.plots.length}.`);
  }
  if (player.plots[index]?.cropId) {
    throw new FarmError(`La parcelle ${index + 1} est déjà occupée.`);
  }
  player.coins -= crop.seedCost;
  player.plots[index] = { cropId, plantedAt: now, notifiedReady: false };
  return index + 1;
}

export function harvest(
  player: PlayerState,
  global: GlobalState,
  now = Date.now(),
): HarvestResult {
  const harvested: HarvestResult["harvested"] = [];
  let totalXp = 0;
  for (const plot of player.plots) {
    if (!plot.cropId || !isReady(player, player.plots.indexOf(plot), now)) continue;
    const crop = cropById(plot.cropId);
    const amount = Math.max(
      1,
      Math.round(crop.baseYield * (1 + player.fertilizerLevel * 0.05)) *
        global.weatherMultiplier,
    );
    player.inventory[crop.id] = (player.inventory[crop.id] ?? 0) + amount;
    player.xp += crop.xp;
    totalXp += crop.xp;
    let replanted = false;
    if (player.autoReplant && player.coins >= crop.seedCost && player.level >= crop.unlockLevel) {
      player.coins -= crop.seedCost;
      plot.plantedAt = now;
      plot.notifiedReady = false;
      replanted = true;
    } else {
      plot.cropId = null;
      plot.plantedAt = null;
      plot.notifiedReady = false;
    }
    harvested.push({ cropId: crop.id, amount, xp: crop.xp, replanted });
  }
  while (player.level < 50 && player.xp >= xpToNextLevel(player.level)) {
    player.xp -= xpToNextLevel(player.level);
    player.level += 1;
  }
  return { harvested, totalXp, leveledUpTo: player.level };
}

export function sell(
  player: PlayerState,
  global: GlobalState,
  itemId: InventoryId | "all",
  requestedAmount: number | null,
): SellResult {
  const itemIds: InventoryId[] =
    itemId === "all"
      ? [...CROPS.map((crop) => crop.id), ...RECIPES.map((recipe) => recipe.id)]
      : [itemId];
  const sold: SellResult["sold"] = [];
  let earned = 0;
  let remainingContract = global.contract.remaining;

  for (const currentId of itemIds) {
    const available = player.inventory[currentId] ?? 0;
    const amount = itemId === "all" || requestedAmount === null
      ? available
      : Math.min(available, requestedAmount);
    if (amount <= 0) continue;
    const crop = CROPS.find((candidate) => candidate.id === currentId);
    const normalPrice = crop ? currentCropPrice(global, crop.id) : productPrice(currentId as ProductId);
    const contractedAmount =
      crop?.id === global.contract.cropId ? Math.min(remainingContract, amount) : 0;
    const saleValue =
      contractedAmount * Math.round(normalPrice * global.contract.bonusMultiplier) +
      (amount - contractedAmount) * normalPrice;
    player.inventory[currentId] = available - amount;
    earned += saleValue;
    remainingContract -= contractedAmount;
    sold.push({ itemId: currentId, amount, earned: saleValue });
    if (itemId !== "all") break;
  }
  if (!sold.length) throw new FarmError("Tu n'as aucune ressource de ce type à vendre.");
  player.coins += earned;
  global.contract.remaining = Math.max(0, remainingContract);
  return { sold, earned };
}

export function buyUpgrade(
  player: PlayerState,
  kind: "plots" | "irrigation" | "fertilizer",
  quantity: number,
): { bought: number; spent: number } {
  if (quantity < 1 || quantity > 40) throw new FarmError("La quantité doit être comprise entre 1 et 40.");
  let bought = 0;
  let spent = 0;
  for (let index = 0; index < quantity; index += 1) {
    const current =
      kind === "plots" ? player.plots.length : kind === "irrigation" ? player.irrigationLevel : player.fertilizerLevel;
    const max = kind === "plots" ? MAX_PLOTS : kind === "irrigation" ? MAX_IRRIGATION : MAX_FERTILIZER;
    if (current >= max) break;
    const cost =
      kind === "plots"
        ? Math.round(120 * 1.55 ** (player.plots.length - STARTING_PLOTS))
        : Math.round(200 * 1.45 ** current);
    if (player.coins < cost) break;
    player.coins -= cost;
    spent += cost;
    bought += 1;
    if (kind === "plots") {
      player.plots.push({ cropId: null, plantedAt: null, notifiedReady: false });
    } else if (kind === "irrigation") {
      player.irrigationLevel += 1;
    } else {
      player.fertilizerLevel += 1;
    }
  }
  if (!bought) throw new FarmError("Achat impossible : niveau maximum atteint ou pièces insuffisantes.");
  return { bought, spent };
}

export function craft(player: PlayerState, recipeId: ProductId, quantity: number): number {
  if (quantity < 1 || quantity > 40) throw new FarmError("La quantité doit être comprise entre 1 et 40.");
  const recipe = recipeById(recipeId);
  const maxCraftable = Object.entries(recipe.ingredients).reduce((max, [cropId, needed]) => {
    const available = player.inventory[cropId as CropId] ?? 0;
    return Math.min(max, Math.floor(available / (needed ?? 1)));
  }, quantity);
  if (maxCraftable < quantity) throw new FarmError("Tu n'as pas assez de cultures pour cette recette.");
  for (const [cropId, needed] of Object.entries(recipe.ingredients)) {
    player.inventory[cropId as CropId] = (player.inventory[cropId as CropId] ?? 0) - (needed ?? 0) * quantity;
  }
  player.inventory[recipe.id] = (player.inventory[recipe.id] ?? 0) + quantity;
  return quantity;
}

export function claimDaily(player: PlayerState, now = Date.now()): number {
  if (player.lastDailyAt && now - player.lastDailyAt < DAILY_COOLDOWN_MS) {
    const hours = Math.ceil((DAILY_COOLDOWN_MS - (now - player.lastDailyAt)) / (60 * 60 * 1000));
    throw new FarmError(`Ta récompense revient dans environ ${hours} h.`);
  }
  const reward = 40 + player.level * 2;
  player.coins += reward;
  player.lastDailyAt = now;
  return reward;
}