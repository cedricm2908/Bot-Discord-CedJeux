// Seul endroit ou un DTO PostgreSQL/Drizzle (@workspace/db) est converti en
// GlobalState (le type metier V1). Meme principe que playerAdapter.ts :
// cast assume a la frontiere DB -> domaine pour les valeurs texte libres
// (weather, next_weather_type, crop_id).
import type { GlobalStateRecord } from "@workspace/db/repositories";
import type { ContractState, CropId, DailyChallengeState, GlobalState, WeatherKey } from "../types";

export function toGlobalState(record: GlobalStateRecord): GlobalState {
  const { globalState, contract, dailyChallenge, dailyChallengeContributors } = record;

  const contractState: ContractState = {
    cropId: contract.cropId as CropId,
    required: contract.required,
    remaining: contract.remaining,
    bonusMultiplier: contract.bonusMultiplier,
    renewedAt: contract.renewedAt.getTime(),
  };

  const dailyChallengeState: DailyChallengeState = {
    cropId: dailyChallenge.cropId as CropId,
    target: dailyChallenge.target,
    progress: dailyChallenge.progress,
    contributors: dailyChallengeContributors.map((row) => row.playerId),
    rewardCoins: dailyChallenge.rewardCoins,
    startedAt: dailyChallenge.startedAt.getTime(),
    completed: dailyChallenge.completed,
    rewarded: dailyChallenge.rewarded,
  };

  return {
    marketMultiplier: globalState.marketMultiplier,
    previousMarketMultiplier: globalState.previousMarketMultiplier,
    marketUpdatedAt: globalState.marketUpdatedAt.getTime(),
    weather: globalState.weather as WeatherKey,
    weatherMultiplier: globalState.weatherMultiplier,
    weatherChangedAt: globalState.weatherChangedAt ? globalState.weatherChangedAt.getTime() : null,
    weatherExpiresAt: globalState.weatherExpiresAt ? globalState.weatherExpiresAt.getTime() : null,
    nextWeatherAt: globalState.nextWeatherAt.getTime(),
    nextWeatherType: globalState.nextWeatherType as WeatherKey,
    contract: contractState,
    weeklyStartedAt: globalState.weeklyStartedAt.getTime(),
    dailyChallenge: dailyChallengeState,
  };
}
