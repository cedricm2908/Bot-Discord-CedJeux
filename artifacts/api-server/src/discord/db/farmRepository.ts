// Premiere couche de repository PostgreSQL pour le gameplay Farm2Win.
// LECTURE SEULE dans cette version : aucun INSERT/UPDATE/DELETE, aucune
// transaction. Pas encore branche sur le bot/les slash commands.
//
// Les types metier canoniques (PlayerState, GlobalState) restent ceux de
// V1/api-server (../types) -- @workspace/db ne retourne que des DTO bruts
// (PlayerRecord/GlobalStateRecord). La conversion passe par les adaptateurs
// deja existants (playerAdapter.ts/globalStateAdapter.ts), jamais dupliquee
// ici.
//
// Architecture testable sans connexion DB : `createFarmRepository(deps)` est
// une factory PURE qui ne touche jamais @workspace/db elle-meme -- toutes ses
// dependances (lecture DB + adaptateurs) lui sont injectees. Les tests
// n'appellent que cette factory avec des mocks.
//
// Les exports getPlayer/getAllPlayers/getGlobalState ci-dessous sont la
// version "reelle" (celle qu'un futur branchement utiliserait) : ils
// importent @workspace/db/repositories de facon DYNAMIQUE, uniquement au
// moment de l'appel -- pas au chargement du module. Un import statique
// declencherait immediatement la verification DATABASE_URL de
// lib/db/src/index.ts des le chargement de ce fichier (donc aussi pendant
// les tests), ce que ce fichier evite deliberement.
import { toGlobalState } from "./globalStateAdapter.ts";
import { toPlayerState } from "./playerAdapter.ts";
import type { GlobalState, PlayerState } from "../types";
import type { GlobalStateRecord, PlayerRecord } from "@workspace/db/repositories";

export interface FarmRepositoryDeps {
  getPlayerRecord: (playerId: string) => Promise<PlayerRecord | null>;
  getAllPlayerRecords: () => Promise<PlayerRecord[]>;
  getGlobalStateRecord: () => Promise<GlobalStateRecord | null>;
  toPlayerState: (record: PlayerRecord) => PlayerState;
  toGlobalState: (record: GlobalStateRecord) => GlobalState;
}

export interface FarmRepository {
  getPlayer(playerId: string): Promise<PlayerState | null>;
  getAllPlayers(): Promise<PlayerState[]>;
  getGlobalState(): Promise<GlobalState | null>;
}

export function createFarmRepository(deps: FarmRepositoryDeps): FarmRepository {
  return {
    async getPlayer(playerId) {
      const record = await deps.getPlayerRecord(playerId);
      return record ? deps.toPlayerState(record) : null;
    },
    async getAllPlayers() {
      const records = await deps.getAllPlayerRecords();
      return records.map((record) => deps.toPlayerState(record));
    },
    async getGlobalState() {
      const record = await deps.getGlobalStateRecord();
      return record ? deps.toGlobalState(record) : null;
    },
  };
}

async function getRealDeps(): Promise<FarmRepositoryDeps> {
  const { getPlayerRecord, getAllPlayerRecords, getGlobalStateRecord } = await import(
    "@workspace/db/repositories"
  );
  return { getPlayerRecord, getAllPlayerRecords, getGlobalStateRecord, toPlayerState, toGlobalState };
}

export async function getPlayer(playerId: string): Promise<PlayerState | null> {
  const deps = await getRealDeps();
  return createFarmRepository(deps).getPlayer(playerId);
}

export async function getAllPlayers(): Promise<PlayerState[]> {
  const deps = await getRealDeps();
  return createFarmRepository(deps).getAllPlayers();
}

export async function getGlobalState(): Promise<GlobalState | null> {
  const deps = await getRealDeps();
  return createFarmRepository(deps).getGlobalState();
}
