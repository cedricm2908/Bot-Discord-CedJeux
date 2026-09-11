import { Router, type IRouter, type Request, type Response } from "express";
import { getFarmStore } from "../discord/sharedStore.ts";
import { CROPS, PLOT_SKINS, RECIPES } from "../discord/constants.ts";
import {
  FarmError,
  buyUpgrade,
  buyWeatherForecast,
  chooseSkin,
  claimDaily,
  claimQuest,
  craft,
  currentCropPrice,
  growMinutes,
  growthPercent,
  isReady,
  harvest,
  plant,
  resetQuestsIfNeeded,
  sell,
  totalInventoryValue,
  unlockedAchievements,
  xpToNextLevel,
} from "../discord/farm.ts";
import { ensurePlayerExists, getGlobalState, getPlayer } from "../discord/db/farmRepository.ts";
import { harvestPlayerCrops, plantPlayerCrop, sellPlayerItems } from "../discord/db/farmPlayerActions.ts";
import { shouldUsePostgresRuntime } from "../discord/postgresRuntimeAllowlist.ts";
import type { FarmStore } from "../discord/store";
import type { CropId, GlobalState, InventoryId, PlayerState, PlotSkinId, ProductId } from "../discord/types";

const router: IRouter = Router();

const CLIENT_ID = process.env["DISCORD_CLIENT_ID"] ?? "1544005975307059250";
const CLIENT_SECRET = process.env["DISCORD_CLIENT_SECRET"];
const REDIRECT_URI = "https://workspaceapi-server-production-e501.up.railway.app/activity/";

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string;
}

async function requireDiscordUser(
  authHeader: string | undefined,
): Promise<DiscordUser | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const accessToken = authHeader.slice("Bearer ".length);
  const userResponse = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) return null;
  return (await userResponse.json()) as DiscordUser;
}

// Ne prend que le GlobalState (jamais un FarmStore complet) : cette
// fonction ne lit historiquement que `store.global`, jamais aucune autre
// methode FarmStore (getPlayer/mutatePlayer/save). La signature reflete
// cette dependance reelle -- cela evite aux appelants Postgres (qui n'ont
// jamais de FarmStore JSON, seulement un GlobalState lu via
// getGlobalState()) tout cast "as unknown as FarmStore".
function buildMePayload(discordUser: DiscordUser, player: PlayerState, global: GlobalState) {
  const now = Date.now();
  return {
    user: { id: discordUser.id, username: discordUser.global_name ?? discordUser.username },
    coins: player.coins,
    level: player.level,
    xp: player.xp,
    xpToNext: xpToNextLevel(player.level),
    irrigationLevel: player.irrigationLevel,
    fertilizerLevel: player.fertilizerLevel,
    autoReplant: player.autoReplant,
    inventoryValue: totalInventoryValue(player, global),
    inventory: Object.fromEntries(
      Object.entries(player.inventory).filter(([, amount]) => (amount ?? 0) > 0),
    ),
    plots: player.plots.map((plot, index) => {
      if (!plot.cropId) return { index, empty: true };
      return {
        index,
        cropId: plot.cropId,
        ready: isReady(player, index, now),
        percent: growthPercent(player, index, now),
        plantedAt: plot.plantedAt,
        growMinutes: growMinutes(player, plot.cropId),
        price: currentCropPrice(global, plot.cropId),
      };
    }),
    global: {
      weather: global.weather,
      marketMultiplier: global.marketMultiplier,
    },
    totalHarvested: player.totalHarvested,
    quests: player.quests,
    achievements: unlockedAchievements(player).map((achievement) => ({
      id: achievement.id,
      label: achievement.label,
      emoji: achievement.emoji,
    })),
    plotSkin: player.plotSkin,
    skins: (Object.keys(PLOT_SKINS) as PlotSkinId[]).map((id) => ({
      id,
      ...PLOT_SKINS[id],
      unlocked: player.unlockedSkins.includes(id) || player.level >= PLOT_SKINS[id].unlockLevel,
    })),
    dailyChallenge: {
      cropId: global.dailyChallenge.cropId,
      target: global.dailyChallenge.target,
      progress: global.dailyChallenge.progress,
      rewardCoins: global.dailyChallenge.rewardCoins,
      completed: global.dailyChallenge.completed,
      contributed: global.dailyChallenge.contributors.includes(player.userId),
    },
    weatherForecast: player.weatherForecast,
  };
}

// ===========================================================================
// LOT A -- Activity PostgreSQL, GET /activity/me UNIQUEMENT (lecture seule).
// ===========================================================================
//
// Meme principe d'allowlist que les slash commands (shouldUsePostgresRuntime,
// ../discord/postgresRuntimeAllowlist.ts) : un joueur NON allowliste continue
// EXACTEMENT sur le runtime JSON V1 (store.getPlayer/resetQuestsIfNeeded/
// store.save, inchange). Un joueur allowliste lit son etat via les MEMES
// primitives Postgres deja utilisees par les slash commands
// (ensurePlayerExists/getPlayer/getGlobalState de ../discord/db/farmRepository.ts
// -- AUCUNE nouvelle primitive, aucune regle metier reimplementee ici).
//
// LECTURE SEULE cote Postgres : ni mutatePlayer, ni resetQuestsIfNeeded
// Postgres, ni aucune autre ecriture n'est declenchee dans cette branche --
// le reset de quetes Postgres est explicitement reserve au LOT B (voir
// commentaire ci-dessous sur resolveActivityMe).
//
// buildMePayload() ci-dessus reste STRICTEMENT INCHANGEE : elle ne lit
// jamais rien d'autre que `store.global` (jamais store.getPlayer/mutatePlayer/
// save), donc la branche Postgres peut lui passer un objet minimal
// `{ global }` portant uniquement le GlobalState reellement lu -- le
// contrat de reponse JSON envoye au frontend reste identique, meme forme,
// memes cles, dans les deux branches.
//
// Erreur Postgres (ensurePlayerExists/getPlayer/getGlobalState qui rejette,
// ou getPlayer qui retourne null malgre ensurePlayerExists) => l'erreur
// remonte telle quelle jusqu'au catch de handleGetActivityMe (reponse 500
// controlee) -- JAMAIS de repli silencieux vers le store JSON pour un
// joueur allowliste.
export interface ActivityMeDeps {
  requireDiscordUser: typeof requireDiscordUser;
  getFarmStore: typeof getFarmStore;
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  getPlayer: typeof getPlayer;
  getGlobalState: typeof getGlobalState;
}

const realActivityMeDeps: ActivityMeDeps = {
  requireDiscordUser,
  getFarmStore,
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  getPlayer,
  getGlobalState,
};

export async function resolveActivityMe(
  discordUser: DiscordUser,
  store: FarmStore,
  deps: ActivityMeDeps = realActivityMeDeps,
): Promise<ReturnType<typeof buildMePayload>> {
  if (deps.shouldUsePostgresRuntime(discordUser.id)) {
    await deps.ensurePlayerExists(discordUser.id);
    const player = await deps.getPlayer(discordUser.id);
    if (!player) {
      throw new Error(
        `resolveActivityMe : joueur "${discordUser.id}" introuvable apres ensurePlayerExists -- etat incoherent.`,
      );
    }
    const global = await deps.getGlobalState();
    if (!global) {
      throw new Error("resolveActivityMe : global_state introuvable.");
    }
    // LOT A = lecture seule : PAS de resetQuestsIfNeeded/mutatePlayer ici,
    // volontairement reserve au LOT B (voir en-tete de section ci-dessus).
    return buildMePayload(discordUser, player, global);
  }
  const player = store.getPlayer(discordUser.id);
  if (resetQuestsIfNeeded(player)) await store.save();
  return buildMePayload(discordUser, player, store.global);
}

export async function handleGetActivityMe(
  req: Request,
  res: Response,
  deps: ActivityMeDeps = realActivityMeDeps,
): Promise<void> {
  try {
    const discordUser = await deps.requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const store = await deps.getFarmStore();
    res.json(await resolveActivityMe(discordUser, store, deps));
  } catch (error) {
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

router.post("/activity/token", async (req, res) => {
  try {
    const code = req.body?.code;
    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "code manquant" });
      return;
    }
    if (!CLIENT_SECRET) {
      res.status(500).json({ error: "DISCORD_CLIENT_SECRET non configuré" });
      return;
    }
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      res.status(502).json({ error: "Échange du code impossible", detail: text });
      return;
    }
    const tokenData = (await tokenResponse.json()) as { access_token: string };
    res.json({ access_token: tokenData.access_token });
  } catch (error) {
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/activity/me", (req, res) => {
  void handleGetActivityMe(req, res);
});

router.get("/activity/crops", (_req, res) => {
  res.json({ crops: CROPS, recipes: RECIPES });
});

// ===========================================================================
// LOT ACTIVITY-PG1 -- POST /activity/plant, joueur allowliste UNIQUEMENT.
// ===========================================================================
//
// Meme structure resolveXxx/handleXxx + deps injectables que
// resolveActivityMe/handleGetActivityMe (LOT A) ci-dessus -- permet de
// verifier precisement, en test, que store.mutatePlayer (JSON) n'est
// jamais appele pour un joueur allowliste et inversement.
//
// Reutilise plantPlayerCrop() (farmPlayerActions.ts), deja existante et
// deja testee, exactement la meme primitive que les slash commands
// Postgres -- AUCUNE regle metier dupliquee/reimplementee ici. Erreur
// metier (ex. parcelle deja occupee) levee par plant() (farm.ts) a
// l'interieur de plantPlayerCrop() : remonte telle quelle jusqu'au catch
// FarmError de handleActivityPlant, identique au chemin JSON -- aucun
// traitement special.
export interface ActivityPlantDeps {
  requireDiscordUser: typeof requireDiscordUser;
  getFarmStore: typeof getFarmStore;
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  plantPlayerCrop: typeof plantPlayerCrop;
  getPlayer: typeof getPlayer;
  getGlobalState: typeof getGlobalState;
}

const realActivityPlantDeps: ActivityPlantDeps = {
  requireDiscordUser,
  getFarmStore,
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  plantPlayerCrop,
  getPlayer,
  getGlobalState,
};

export async function resolveActivityPlant(
  discordUser: DiscordUser,
  cropId: CropId,
  plotNumber: number | null,
  store: FarmStore,
  deps: ActivityPlantDeps = realActivityPlantDeps,
): Promise<ReturnType<typeof buildMePayload>> {
  if (deps.shouldUsePostgresRuntime(discordUser.id)) {
    await deps.ensurePlayerExists(discordUser.id);
    await deps.plantPlayerCrop(discordUser.id, cropId, plotNumber);
    const player = await deps.getPlayer(discordUser.id);
    if (!player) {
      throw new Error(
        `resolveActivityPlant : joueur "${discordUser.id}" introuvable apres ensurePlayerExists -- etat incoherent.`,
      );
    }
    const global = await deps.getGlobalState();
    if (!global) {
      throw new Error("resolveActivityPlant : global_state introuvable.");
    }
    return buildMePayload(discordUser, player, global);
  }
  const player = await store.mutatePlayer(discordUser.id, (p) => {
    plant(p, cropId, plotNumber);
  });
  return buildMePayload(discordUser, player, store.global);
}

export async function handleActivityPlant(
  req: Request,
  res: Response,
  deps: ActivityPlantDeps = realActivityPlantDeps,
): Promise<void> {
  try {
    const discordUser = await deps.requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const cropId = req.body?.cropId as CropId | undefined;
    const plotNumber = typeof req.body?.plot === "number" ? req.body.plot : null;
    if (!cropId || !CROPS.some((c) => c.id === cropId)) {
      res.status(400).json({ error: "Culture invalide" });
      return;
    }
    const store = await deps.getFarmStore();
    res.json(await resolveActivityPlant(discordUser, cropId, plotNumber, store, deps));
  } catch (error) {
    if (error instanceof FarmError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

router.post("/activity/plant", (req, res) => {
  void handleActivityPlant(req, res);
});

// ===========================================================================
// LOT ACTIVITY-PG2 -- POST /activity/harvest, joueur allowliste UNIQUEMENT.
// ===========================================================================
//
// Meme structure resolveXxx/handleXxx + deps injectables que
// resolveActivityPlant/handleActivityPlant (LOT ACTIVITY-PG1) ci-dessus.
//
// Reutilise harvestPlayerCrops() (farmPlayerActions.ts), deja existante et
// deja testee, exactement la meme primitive que les slash commands
// Postgres (mutatePlayerAndGlobal, verrouille joueur+global ensemble --
// necessaire car harvest() mute aussi le defi quotidien). AUCUNE regle
// metier dupliquee/reimplementee ici -- le calcul de rendement (round
// final apres multiplicateur meteo) vit exclusivement dans harvest()
// (farm.ts), inchange.
//
// harvestPlayerCrops() retourne { result, global } mais PAS le player mis
// a jour (mutatePlayerAndGlobal() le retourne, mais harvestPlayerCrops()
// ne le propage pas) -- une relecture explicite via getPlayer() est donc
// necessaire, exactement comme demande. Pour rester coherent avec le
// pattern deja etabli par resolveActivityPlant (une seule source de
// verite : une relecture fraiche post-ecriture plutot que de reutiliser
// une valeur de retour partielle), l'etat global est lui aussi relu via
// getGlobalState() plutot que de reutiliser celui deja renvoye par
// harvestPlayerCrops().
//
// "Aucune parcelle prete" : harvest() (farm.ts) ne leve pas d'erreur dans
// ce cas (result.harvested reste un tableau vide) -- c'est le HANDLER,
// cote V1 JSON comme cote Postgres, qui traduit ce cas en 400, IDENTIQUE
// dans les deux branches (meme message, meme statut).
export interface ActivityHarvestDeps {
  requireDiscordUser: typeof requireDiscordUser;
  getFarmStore: typeof getFarmStore;
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  harvestPlayerCrops: typeof harvestPlayerCrops;
  getPlayer: typeof getPlayer;
  getGlobalState: typeof getGlobalState;
}

const realActivityHarvestDeps: ActivityHarvestDeps = {
  requireDiscordUser,
  getFarmStore,
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  harvestPlayerCrops,
  getPlayer,
  getGlobalState,
};

export type ActivityHarvestResult =
  | { status: 200; payload: ReturnType<typeof buildMePayload> }
  | { status: 400; error: string };

export async function resolveActivityHarvest(
  discordUser: DiscordUser,
  store: FarmStore,
  deps: ActivityHarvestDeps = realActivityHarvestDeps,
): Promise<ActivityHarvestResult> {
  if (deps.shouldUsePostgresRuntime(discordUser.id)) {
    await deps.ensurePlayerExists(discordUser.id);
    const { result } = await deps.harvestPlayerCrops(discordUser.id);
    if (!result.harvested.length) {
      return { status: 400, error: "Aucune parcelle n'est prête pour le moment." };
    }
    const player = await deps.getPlayer(discordUser.id);
    if (!player) {
      throw new Error(
        `resolveActivityHarvest : joueur "${discordUser.id}" introuvable apres ensurePlayerExists -- etat incoherent.`,
      );
    }
    const global = await deps.getGlobalState();
    if (!global) {
      throw new Error("resolveActivityHarvest : global_state introuvable.");
    }
    return { status: 200, payload: buildMePayload(discordUser, player, global) };
  }
  let result: ReturnType<typeof harvest> | undefined;
  const player = await store.mutatePlayer(discordUser.id, (p) => {
    result = harvest(p, store.global);
  });
  if (!result?.harvested.length) {
    return { status: 400, error: "Aucune parcelle n'est prête pour le moment." };
  }
  return { status: 200, payload: buildMePayload(discordUser, player, store.global) };
}

export async function handleActivityHarvest(
  req: Request,
  res: Response,
  deps: ActivityHarvestDeps = realActivityHarvestDeps,
): Promise<void> {
  try {
    const discordUser = await deps.requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const store = await deps.getFarmStore();
    const outcome = await resolveActivityHarvest(discordUser, store, deps);
    if (outcome.status === 400) {
      res.status(400).json({ error: outcome.error });
      return;
    }
    res.json(outcome.payload);
  } catch (error) {
    if (error instanceof FarmError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

router.post("/activity/harvest", (req, res) => {
  void handleActivityHarvest(req, res);
});

// ===========================================================================
// LOT ACTIVITY-PG3 -- POST /activity/sell, joueur allowliste UNIQUEMENT.
// ===========================================================================
//
// Meme structure resolveXxx/handleXxx + deps injectables que
// resolveActivityPlant/handleActivityPlant (LOT ACTIVITY-PG1) ci-dessus.
//
// Reutilise sellPlayerItems() (farmPlayerActions.ts), deja existante et
// deja testee, exactement la meme primitive que les slash commands
// Postgres (mutatePlayerAndGlobal, verrouille joueur+global ensemble --
// necessaire car sell() mute aussi contract.remaining). AUCUNE regle
// metier dupliquee/reimplementee ici -- prix marche (currentCropPrice/
// productPrice), bonus de contrat et validations d'inventaire vivent
// exclusivement dans sell() (farm.ts), inchange.
//
// Contrairement a harvestPlayerCrops() ("aucune parcelle prete" = resultat
// vide, pas une erreur), sell() leve une FarmError explicite pour toute
// vente invalide (aucune ressource, quantite hors bornes) -- deja geree
// par le meme catch FarmError que le chemin JSON ci-dessous, sans
// traitement special.
//
// sellPlayerItems() retourne { result, global } mais PAS le player mis a
// jour -- une relecture explicite via getPlayer() est donc necessaire,
// exactement comme pour plant/harvest. L'etat global est lui aussi relu
// via getGlobalState() plutot que de reutiliser celui deja renvoye par
// sellPlayerItems(), pour rester coherent avec les LOTs precedents.
export interface ActivitySellDeps {
  requireDiscordUser: typeof requireDiscordUser;
  getFarmStore: typeof getFarmStore;
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  sellPlayerItems: typeof sellPlayerItems;
  getPlayer: typeof getPlayer;
  getGlobalState: typeof getGlobalState;
}

const realActivitySellDeps: ActivitySellDeps = {
  requireDiscordUser,
  getFarmStore,
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  sellPlayerItems,
  getPlayer,
  getGlobalState,
};

export async function resolveActivitySell(
  discordUser: DiscordUser,
  itemId: InventoryId | "all",
  amount: number | null,
  store: FarmStore,
  deps: ActivitySellDeps = realActivitySellDeps,
): Promise<ReturnType<typeof buildMePayload>> {
  if (deps.shouldUsePostgresRuntime(discordUser.id)) {
    await deps.ensurePlayerExists(discordUser.id);
    await deps.sellPlayerItems(discordUser.id, itemId, amount);
    const player = await deps.getPlayer(discordUser.id);
    if (!player) {
      throw new Error(
        `resolveActivitySell : joueur "${discordUser.id}" introuvable apres ensurePlayerExists -- etat incoherent.`,
      );
    }
    const global = await deps.getGlobalState();
    if (!global) {
      throw new Error("resolveActivitySell : global_state introuvable.");
    }
    return buildMePayload(discordUser, player, global);
  }
  const player = await store.mutatePlayer(discordUser.id, (p) => {
    sell(p, store.global, itemId, amount);
  });
  return buildMePayload(discordUser, player, store.global);
}

export async function handleActivitySell(
  req: Request,
  res: Response,
  deps: ActivitySellDeps = realActivitySellDeps,
): Promise<void> {
  try {
    const discordUser = await deps.requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const itemId = (req.body?.itemId as InventoryId | "all" | undefined) ?? "all";
    const amount = typeof req.body?.amount === "number" ? req.body.amount : null;
    const store = await deps.getFarmStore();
    res.json(await resolveActivitySell(discordUser, itemId, amount, store, deps));
  } catch (error) {
    if (error instanceof FarmError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

router.post("/activity/sell", (req, res) => {
  void handleActivitySell(req, res);
});

router.post("/activity/buy", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const kind = req.body?.kind as "plots" | "irrigation" | "fertilizer" | undefined;
    const quantity = typeof req.body?.quantity === "number" ? req.body.quantity : 1;
    if (!kind) {
      res.status(400).json({ error: "Amélioration invalide" });
      return;
    }
    const store = await getFarmStore();
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      buyUpgrade(p, kind, quantity);
    });
    res.json(buildMePayload(discordUser, player, store.global));
  } catch (error) {
    if (error instanceof FarmError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post("/activity/craft", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const recipeId = req.body?.recipeId as ProductId | undefined;
    const quantity = typeof req.body?.quantity === "number" ? req.body.quantity : 1;
    if (!recipeId) {
      res.status(400).json({ error: "Recette invalide" });
      return;
    }
    const store = await getFarmStore();
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      craft(p, recipeId, quantity);
    });
    res.json(buildMePayload(discordUser, player, store.global));
  } catch (error) {
    if (error instanceof FarmError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post("/activity/daily", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const store = await getFarmStore();
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      claimDaily(p);
    });
    res.json(buildMePayload(discordUser, player, store.global));
  } catch (error) {
    if (error instanceof FarmError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post("/activity/quest-claim", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const questIndex = typeof req.body?.questIndex === "number" ? req.body.questIndex : -1;
    const store = await getFarmStore();
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      claimQuest(p, questIndex);
    });
    res.json(buildMePayload(discordUser, player, store.global));
  } catch (error) {
    if (error instanceof FarmError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post("/activity/skin", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const skinId = req.body?.skinId as PlotSkinId | undefined;
    if (!skinId) {
      res.status(400).json({ error: "Thème invalide" });
      return;
    }
    const store = await getFarmStore();
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      chooseSkin(p, skinId);
    });
    res.json(buildMePayload(discordUser, player, store.global));
  } catch (error) {
    if (error instanceof FarmError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post("/activity/forecast", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const store = await getFarmStore();
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      buyWeatherForecast(p, store.global);
    });
    res.json(buildMePayload(discordUser, player, store.global));
  } catch (error) {
    if (error instanceof FarmError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post("/activity/autoreplant", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const store = await getFarmStore();
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      p.autoReplant = !p.autoReplant;
    });
    res.json(buildMePayload(discordUser, player, store.global));
  } catch (error) {
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
