// Repository EN LECTURE SEULE. Ne connait que PostgreSQL/Drizzle : retourne
// des DTO bruts (types inferes du schema), jamais une forme "domaine"
// (GlobalState). La conversion est la responsabilite exclusive de
// l'adaptateur cote api-server (globalStateAdapter.ts).
//
// global_state et contract sont des lignes singleton (id = 1). daily_challenge
// suit le modele historique : une nouvelle ligne par defi, jamais purgee.
// "Le defi actuel" est le plus recent par started_at, avec id en tie-break
// deterministe (started_at seul n'est pas garanti unique).
import { desc, eq } from "drizzle-orm";
import { db } from "../index";
import { contract, dailyChallenge, dailyChallengeContributors, globalState } from "../schema";
import type {
  ContractRow,
  DailyChallengeContributor,
  DailyChallengeRow,
  GlobalStateRow,
} from "../schema";

export interface GlobalStateRecord {
  globalState: GlobalStateRow;
  contract: ContractRow;
  dailyChallenge: DailyChallengeRow;
  dailyChallengeContributors: DailyChallengeContributor[];
}

export async function getGlobalStateRecord(): Promise<GlobalStateRecord | null> {
  const [globalRow] = await db
    .select()
    .from(globalState)
    .where(eq(globalState.id, 1))
    .limit(1);
  if (!globalRow) return null;

  const [contractRow] = await db
    .select()
    .from(contract)
    .where(eq(contract.id, 1))
    .limit(1);
  if (!contractRow) {
    throw new Error(
      "global_state present mais aucune ligne contract trouvee -- etat incoherent (initialisation incomplete).",
    );
  }

  const [challengeRow] = await db
    .select()
    .from(dailyChallenge)
    .orderBy(desc(dailyChallenge.startedAt), desc(dailyChallenge.id))
    .limit(1);
  if (!challengeRow) {
    throw new Error(
      "global_state present mais aucun daily_challenge trouve -- etat incoherent (initialisation incomplete).",
    );
  }

  const contributorRows = await db
    .select()
    .from(dailyChallengeContributors)
    .where(eq(dailyChallengeContributors.challengeId, challengeRow.id));

  return {
    globalState: globalRow,
    contract: contractRow,
    dailyChallenge: challengeRow,
    dailyChallengeContributors: contributorRows,
  };
}
