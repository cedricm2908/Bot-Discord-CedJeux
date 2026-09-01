export type WeatherKey = "normal" | "rain" | "pests";

export type CropId =
  | "wheat"
  | "carrot"
  | "potato"
  | "beetroot"
  | "melon"
  | "pumpkin"
  | "sugar_cane"
  | "cocoa"
  | "nether_wart"
  | "chorus_fruit";

export type ProductId = "bread" | "pumpkin_pie" | "sugar_syrup";
export type InventoryId = CropId | ProductId;

export interface CropDefinition {
  id: CropId;
  name: string;
  emoji: string;
  unlockLevel: number;
  seedCost: number;
  growMinutes: number;
  baseYield: number;
  basePrice: number;
  xp: number;
}

export interface RecipeDefinition {
  id: ProductId;
  name: string;
  emoji: string;
  ingredients: Partial<Record<CropId, number>>;
  sellPrice: number;
}

export interface Plot {
  cropId: CropId | null;
  plantedAt: number | null;
  notifiedReady: boolean;
}

export interface PlayerState {
  userId: string;
  coins: number;
  level: number;
  xp: number;
  plots: Plot[];
  inventory: Partial<Record<InventoryId, number>>;
  irrigationLevel: number;
  fertilizerLevel: number;
  lastDailyAt: number | null;
  autoReplant: boolean;
  weeklySnapshotCoins: number;
  createdAt: number;
  updatedAt: number;
}

export interface ContractState {
  cropId: CropId;
  required: number;
  remaining: number;
  bonusMultiplier: number;
  renewedAt: number;
}

export interface GlobalState {
  marketMultiplier: number;
  previousMarketMultiplier: number;
  marketUpdatedAt: number;
  weather: WeatherKey;
  weatherMultiplier: number;
  weatherChangedAt: number | null;
  weatherExpiresAt: number | null;
  nextWeatherAt: number;
  contract: ContractState;
  weeklyStartedAt: number;
}

export interface FarmDatabase {
  version: 1;
  players: Record<string, PlayerState>;
  global: GlobalState;
}