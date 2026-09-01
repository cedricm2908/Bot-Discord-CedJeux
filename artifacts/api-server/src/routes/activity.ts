import { Router, type IRouter } from "express";
import { getFarmStore } from "../discord/sharedStore";
import { CROPS, RECIPES } from "../discord/constants";
import {
  currentCropPrice,
  growMinutes,
  growthPercent,
  isReady,
  totalInventoryValue,
  xpToNextLevel,
} from "../discord/farm";

const router: IRouter = Router();

const CLIENT_ID = process.env["DISCORD_CLIENT_ID"] ?? "1544005975307059250";
const CLIENT_SECRET = process.env["DISCORD_CLIENT_SECRET"];

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
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }
    const accessToken = authHeader.slice("Bearer ".length);
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userResponse.ok) {
      res.status(401).json({ error: "Token Discord invalide" });
      return;
    }
    const discordUser = (await userResponse.json()) as {
      id: string;
      username: string;
      global_name?: string;
    };

    const store = await getFarmStore();
    const player = store.getPlayer(discordUser.id);
    const now = Date.now();

    res.json({
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
    });
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

export default router;
