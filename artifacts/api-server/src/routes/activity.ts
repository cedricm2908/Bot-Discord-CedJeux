import { Router, type IRouter } from "express";
import { getFarmStore } from "../discord/sharedStore";
import { CROPS, PLOT_SKINS, RECIPES } from "../discord/constants";
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
} from "../discord/farm";
import type { FarmStore } from "../discord/store";
import type { CropId, InventoryId, PlayerState, PlotSkinId, ProductId } from "../discord/types";

const router: IRouter = Router();

const CLIENT_ID = process.env["DISCORD_CLIENT_ID"] ?? "1544005975307059250";
const CLIENT_SECRET = process.env["DISCORD_CLIENT_SECRET"];
const REDIRECT_URI = "https://cedricm2908.github.io/CedJeux/activity/";

interface DiscordUser {
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

function buildMePayload(discordUser: DiscordUser, player: PlayerState, store: FarmStore) {
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
    inventoryValue: totalInventoryValue(player, store.global),
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
        price: currentCropPrice(store.global, plot.cropId),
      };
    }),
    global: {
      weather: store.global.weather,
      marketMultiplier: store.global.marketMultiplier,
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
      cropId: store.global.dailyChallenge.cropId,
      target: store.global.dailyChallenge.target,
      progress: store.global.dailyChallenge.progress,
      rewardCoins: store.global.dailyChallenge.rewardCoins,
      completed: store.global.dailyChallenge.completed,
      contributed: store.global.dailyChallenge.contributors.includes(player.userId),
    },
    weatherForecast: player.weatherForecast,
  };
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

router.get("/activity/me", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const store = await getFarmStore();
    const player = store.getPlayer(discordUser.id);
    if (resetQuestsIfNeeded(player)) await store.save();
    res.json(buildMePayload(discordUser, player, store));
  } catch (error) {
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/activity/crops", (_req, res) => {
  res.json({ crops: CROPS, recipes: RECIPES });
});

router.post("/activity/plant", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
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
    const store = await getFarmStore();
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      plant(p, cropId, plotNumber);
    });
    res.json(buildMePayload(discordUser, player, store));
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

router.post("/activity/harvest", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const store = await getFarmStore();
    let result: ReturnType<typeof harvest> | undefined;
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      result = harvest(p, store.global);
    });
    if (!result?.harvested.length) {
      res.status(400).json({ error: "Aucune parcelle n'est prête pour le moment." });
      return;
    }
    res.json(buildMePayload(discordUser, player, store));
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

router.post("/activity/sell", async (req, res) => {
  try {
    const discordUser = await requireDiscordUser(req.headers.authorization);
    if (!discordUser) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const itemId = (req.body?.itemId as InventoryId | "all" | undefined) ?? "all";
    const amount = typeof req.body?.amount === "number" ? req.body.amount : null;
    const store = await getFarmStore();
    const player = await store.mutatePlayer(discordUser.id, (p) => {
      sell(p, store.global, itemId, amount);
    });
    res.json(buildMePayload(discordUser, player, store));
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
    res.json(buildMePayload(discordUser, player, store));
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
    res.json(buildMePayload(discordUser, player, store));
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
    res.json(buildMePayload(discordUser, player, store));
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
    res.json(buildMePayload(discordUser, player, store));
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
    res.json(buildMePayload(discordUser, player, store));
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
    res.json(buildMePayload(discordUser, player, store));
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
    res.json(buildMePayload(discordUser, player, store));
  } catch (error) {
    res.status(500).json({
      error: "Erreur serveur",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
