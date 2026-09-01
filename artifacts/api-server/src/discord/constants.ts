import type {
  CropDefinition,
  CropId,
  GlobalState,
  ProductId,
  RecipeDefinition,
  WeatherKey,
} from "./types";

export const MINI_GAMES = [
  {
    name: "🌾 Farm2Win",
    description:
      "Cultive des ressources façon Minecraft, améliore ta production et deviens numéro 1 de l'économie du serveur !",
  },
] as const;

export const CROPS: readonly CropDefinition[] = [
  { id: "wheat", name: "Blé", emoji: "🌾", unlockLevel: 1, seedCost: 5, growMinutes: 5, baseYield: 3, basePrice: 4, xp: 2 },
  { id: "carrot", name: "Carotte", emoji: "🥕", unlockLevel: 1, seedCost: 8, growMinutes: 8, baseYield: 3, basePrice: 6, xp: 3 },
  { id: "potato", name: "Pomme de terre", emoji: "🥔", unlockLevel: 5, seedCost: 12, growMinutes: 12, baseYield: 4, basePrice: 9, xp: 5 },
  { id: "beetroot", name: "Betterave", emoji: "🟥", unlockLevel: 5, seedCost: 14, growMinutes: 14, baseYield: 4, basePrice: 10, xp: 5 },
  { id: "melon", name: "Melon", emoji: "🍈", unlockLevel: 12, seedCost: 20, growMinutes: 20, baseYield: 6, basePrice: 15, xp: 8 },
  { id: "pumpkin", name: "Citrouille", emoji: "🎃", unlockLevel: 12, seedCost: 25, growMinutes: 25, baseYield: 6, basePrice: 18, xp: 9 },
  { id: "sugar_cane", name: "Canne à sucre", emoji: "🎋", unlockLevel: 20, seedCost: 35, growMinutes: 30, baseYield: 8, basePrice: 25, xp: 12 },
  { id: "cocoa", name: "Cacao", emoji: "🍫", unlockLevel: 20, seedCost: 40, growMinutes: 35, baseYield: 8, basePrice: 28, xp: 13 },
  { id: "nether_wart", name: "Verrue du Nether", emoji: "🔥", unlockLevel: 30, seedCost: 60, growMinutes: 45, baseYield: 10, basePrice: 45, xp: 20 },
  { id: "chorus_fruit", name: "Fruit chorus", emoji: "🟪", unlockLevel: 45, seedCost: 100, growMinutes: 60, baseYield: 12, basePrice: 80, xp: 35 },
];

export const RECIPES: readonly RecipeDefinition[] = [
  { id: "bread", name: "Pain", emoji: "🍞", ingredients: { wheat: 3 }, sellPrice: 18 },
  { id: "pumpkin_pie", name: "Tarte à la citrouille", emoji: "🥧", ingredients: { pumpkin: 2, wheat: 1 }, sellPrice: 55 },
  { id: "sugar_syrup", name: "Sirop de canne", emoji: "🍯", ingredients: { sugar_cane: 4 }, sellPrice: 95 },
];

export const WEATHER_INFO: Record<
  WeatherKey,
  { label: string; emoji: string; multiplier: number }
> = {
  normal: { label: "Normal", emoji: "☀️", multiplier: 1 },
  rain: { label: "Pluie bénie", emoji: "☔", multiplier: 1.25 },
  pests: { label: "Invasion de parasites", emoji: "🐛", multiplier: 0.75 },
};

export const TIER_INFO = [
  { level: 1, name: "Plaine", emoji: "🟢", color: 0x3f6b2f },
  { level: 5, name: "Village", emoji: "🟡", color: 0x8a6420 },
  { level: 12, name: "Verger", emoji: "🟠", color: 0xa8541f },
  { level: 20, name: "Jungle", emoji: "🔵", color: 0x1f6f60 },
  { level: 30, name: "Nether", emoji: "🔴", color: 0x8c2f2f },
  { level: 45, name: "End", emoji: "🟣", color: 0x5b3c96 },
] as const;

export const STARTING_COINS = 50;
export const STARTING_PLOTS = 4;
export const MAX_PLOTS = 40;
export const MAX_IRRIGATION = 15;
export const MAX_FERTILIZER = 20;
export const DAILY_COOLDOWN_MS = 20 * 60 * 60 * 1000;
export const MARKET_INTERVAL_MS = 30 * 60 * 1000;
export const CONTRACT_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function cropById(id: CropId): CropDefinition {
  const crop = CROPS.find((candidate) => candidate.id === id);
  if (!crop) throw new Error(`Culture inconnue: ${id}`);
  return crop;
}

export function recipeById(id: ProductId): RecipeDefinition {
  const recipe = RECIPES.find((candidate) => candidate.id === id);
  if (!recipe) throw new Error(`Recette inconnue: ${id}`);
  return recipe;
}

export function defaultGlobalState(now = Date.now()): GlobalState {
  return {
    marketMultiplier: 1,
    previousMarketMultiplier: 1,
    marketUpdatedAt: now,
    weather: "normal",
    weatherMultiplier: 1,
    weatherChangedAt: null,
    weatherExpiresAt: null,
    nextWeatherAt: now + randomBetween(2 * 60 * 60 * 1000, 4 * 60 * 60 * 1000),
    contract: {
      cropId: "wheat",
      required: 20,
      remaining: 20,
      bonusMultiplier: 1.6,
      renewedAt: now,
    },
    weeklyStartedAt: now,
  };
}

export function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}