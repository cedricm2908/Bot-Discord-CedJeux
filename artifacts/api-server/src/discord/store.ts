import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CROPS,
  MAX_PLOTS,
  STARTING_COINS,
  STARTING_PLOTS,
  defaultGlobalState,
} from "./constants";
import type { FarmDatabase, PlayerState } from "./types";

const dataFile = path.resolve(
  process.env["FARM_DATA_FILE"] ?? "./data/farm2win.json",
);

function createPlayer(userId: string, now = Date.now()): PlayerState {
  return {
    userId,
    coins: STARTING_COINS,
    level: 1,
    xp: 0,
    plots: Array.from({ length: STARTING_PLOTS }, () => ({
      cropId: null,
      plantedAt: null,
      notifiedReady: false,
    })),
    inventory: Object.fromEntries(CROPS.map((crop) => [crop.id, 0])),
    irrigationLevel: 0,
    fertilizerLevel: 0,
    lastDailyAt: null,
    autoReplant: false,
    weeklySnapshotCoins: STARTING_COINS,
    createdAt: now,
    updatedAt: now,
  };
}

export class FarmStore {
  private database: FarmDatabase | null = null;
  private saveChain: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    try {
      const raw = await readFile(dataFile, "utf8");
      const parsed = JSON.parse(raw) as FarmDatabase;
      if (parsed.version !== 1 || !parsed.players || !parsed.global) {
        throw new Error("format de données Farm2Win inconnu");
      }
      parsed.global.weatherExpiresAt ??= null;
      this.database = parsed;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : "";
      if (code !== "ENOENT") {
        throw new Error(
          `Impossible de lire ${dataFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.database = { version: 1, players: {}, global: defaultGlobalState() };
      await this.save();
    }
  }

  get global() {
    return this.getDatabase().global;
  }

  getPlayer(userId: string): PlayerState {
    const database = this.getDatabase();
    const player = database.players[userId] ?? createPlayer(userId);
    database.players[userId] = player;
    return player;
  }

  getPlayers(): PlayerState[] {
    return Object.values(this.getDatabase().players);
  }

  async save(): Promise<void> {
    const database = this.getDatabase();
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(path.dirname(dataFile), { recursive: true });
      const temporary = `${dataFile}.tmp`;
      await writeFile(temporary, JSON.stringify(database, null, 2), "utf8");
      await rename(temporary, dataFile);
    });
    return this.saveChain;
  }

  async mutatePlayer(
    userId: string,
    mutator: (player: PlayerState) => void,
  ): Promise<PlayerState> {
    const player = this.getPlayer(userId);
    mutator(player);
    player.updatedAt = Date.now();
    await this.save();
    return player;
  }

  private getDatabase(): FarmDatabase {
    if (!this.database) throw new Error("FarmStore non initialisé");
    return this.database;
  }
}

export { MAX_PLOTS };