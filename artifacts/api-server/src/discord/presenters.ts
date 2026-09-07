import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
} from "discord.js";
import {
  CROPS,
  MINI_GAMES,
  RECIPES,
  TIER_INFO,
  WEATHER_INFO,
  cropById,
  recipeById,
} from "./constants.ts";
import {
  FarmError,
  buyUpgrade,
  claimDaily,
  craft,
  currentCropPrice,
  growMinutes,
  growthPercent,
  harvest,
  enrichGlobalState,
  isReady,
  plant,
  productPrice,
  sell,
  totalInventoryValue,
  xpToNextLevel,
} from "./farm.ts";
import { FarmStore } from "./store.ts";
import {
  buyPlayerUpgrade,
  claimPlayerDaily,
  craftPlayerItem,
  harvestPlayerCrops,
  plantPlayerCrop,
  sellPlayerItems,
} from "./db/farmPlayerActions.ts";
import { ensurePlayerExists, getGlobalState, getPlayer } from "./db/farmRepository.ts";
import { shouldUsePostgresRuntime } from "./postgresRuntimeAllowlist.ts";
import type {
  CropId,
  GlobalState,
  InventoryId,
  PlayerState,
  ProductId,
} from "./types";

const invisible = "\u200b";

function cropIdFrom(value: string): CropId {
  if (!CROPS.some((crop) => crop.id === value)) {
    throw new FarmError("Cette culture n'existe pas.");
  }
  return value as CropId;
}

function productIdFrom(value: string): ProductId {
  if (!RECIPES.some((recipe) => recipe.id === value)) {
    throw new FarmError("Cette recette n'existe pas.");
  }
  return value as ProductId;
}

function inventoryIdFrom(value: string): InventoryId | "all" {
  if (value === "all") return value;
  if (
    !CROPS.some((crop) => crop.id === value) &&
    !RECIPES.some((recipe) => recipe.id === value)
  ) {
    throw new FarmError("Cette ressource n'existe pas.");
  }
  return value as InventoryId;
}

function formatCoins(amount: number): string {
  return `${Math.round(amount).toLocaleString("fr-FR")} pièces`;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes * 10) / 10} min`;
  return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`;
}

function progressBar(percent: number, length = 10): string {
  const green = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
  return `${"🟩".repeat(green)}${"⬜".repeat(length - green)}`;
}

function stageFor(cropLevel: number) {
  let selected: (typeof TIER_INFO)[number] = TIER_INFO[0];
  for (const tier of TIER_INFO) {
    if (cropLevel >= tier.level) selected = tier;
  }
  return selected;
}

// Extrait de weatherLine() ci-dessous pour accepter directement un
// GlobalState (LOT 6, /harvest) : le chemin Postgres de resolveHarvestCrops
// retourne le GlobalState REELLEMENT utilise pour calculer le rendement de
// la recolte (via mutatePlayerAndGlobal) -- afficher la meteo depuis
// store.global (JSON) serait incorrect pour un joueur allowliste, puisque
// ce n'est pas necessairement le meme etat global que celui utilise pour
// le calcul. weatherLine(store) reste inchangee pour tous ses autres
// appelants (commandFarm, codexPayload), qui continuent de lire store.global
// exactement comme avant -- aucune duplication de logique, un seul
// formattage partage.
function weatherLineForGlobal(global: GlobalState): string {
  const weather = WEATHER_INFO[global.weather];
  return `${weather.emoji} ${weather.label} · rendement ×${weather.multiplier}`;
}

function weatherLine(store: FarmStore): string {
  return weatherLineForGlobal(store.global);
}

function embedError(error: unknown): EmbedBuilder {
  const message = error instanceof FarmError
    ? error.message
    : "Une erreur inattendue est survenue. Réessaie dans un instant.";
  return new EmbedBuilder()
    .setColor(0xb23b3b)
    .setTitle("Action impossible")
    .setDescription(`⚠️ ${message}`);
}

async function replyError(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  error: unknown,
): Promise<void> {
  const payload = { embeds: [embedError(error)], ephemeral: true };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

function playerName(interaction: ChatInputCommandInteraction): string {
  return interaction.member && "displayName" in interaction.member
    ? interaction.member.displayName
    : interaction.user.globalName ?? interaction.user.username;
}

// LOT 6 : commandes ENTIEREMENT routees vers Postgres pour un joueur
// allowliste -- utilise UNIQUEMENT pour eviter le
// enrichGlobalState(store.global)+store.save() ci-dessous (qui ecrirait le
// fichier JSON) quand cette commande precise, pour CE joueur precis,
// n'aura de toute facon AUCUNE ecriture JSON (ni joueur, ni globale).
// buyUpgrade()/claimDaily()/plant()/craft() sont des fonctions PLAYER-ONLY
// (jamais de global_state implique, verifie a l'audit de chaque
// branchement). harvest()/sell() sont DIFFERENTES -- elles mutent aussi
// l'etat global (daily_challenge pour harvest, contract.remaining pour
// sell), mais UNIQUEMENT celui de PostgreSQL (via mutatePlayerAndGlobal(),
// voir resolveHarvestCrops/resolveSellItems plus bas) -- jamais
// store.global/JSON, qui n'est simplement jamais touche du tout dans la
// branche Postgres. Sauter ce preambule JSON reste donc tout aussi sans
// consequence pour /harvest et /sell. /inventory est encore une TROISIEME
// categorie -- purement LECTURE SEULE (aucune fonction farm.ts mutante
// impliquee), mais elle LIT tout de meme le GlobalState (marketMultiplier,
// via currentCropPrice()) pour l'affichage de la valeur des cultures ;
// resolveInventory() lit ce GlobalState via getGlobalState() (Postgres)
// cote allowliste, jamais store.global -- aucune ecriture, ni joueur ni
// globale, dans les deux branches. /farm est la MEME categorie que
// /inventory (LECTURE SEULE, mais depend du GlobalState uniquement pour la
// ligne meteo affichee, WEATHER_INFO[global.weather] via
// weatherLineForGlobal()) -- verifie a l'audit : growMinutes()/isReady()/
// growthPercent() (temps restant, statut pret) ne dependent QUE du
// PlayerState (plots, irrigationLevel), jamais du GlobalState.
// resolveFarmView() lit le GlobalState via getGlobalState() (Postgres) cote
// allowliste, jamais store.global. /profile est la MEME categorie que
// /inventory et /farm (LECTURE SEULE) -- verifie a l'audit : commandProfile
// n'affiche NI achievements, NI skins/unlockedSkins, NI quests, NI
// totalHarvested, NI weeklySnapshotCoins (V1 reel, malgre ce que ces champs
// du PlayerState pourraient suggerer) -- seulement level/xp/coins/
// plots.length/irrigationLevel/fertilizerLevel/autoReplant (PLAYER-ONLY) et
// totalInventoryValue(player, global), qui depend du GlobalState
// (marketMultiplier) exactement comme /inventory. resolveProfile() lit ce
// GlobalState via getGlobalState() (Postgres) cote allowliste, jamais
// store.global. /market est une QUATRIEME categorie -- GLOBAL-ONLY :
// commandMarket ne lit AUCUNE donnee Player (verifie a l'audit, aucun
// store.getPlayer() dans son corps), uniquement store.global.
// marketMultiplier/previousMarketMultiplier et currentCropPrice(). Consequence
// directe : resolveMarket() n'appelle jamais le bootstrap ensurePlayerExists
// pour un joueur allowliste -- creer un joueur Postgres juste pour afficher le
// marche serait un effet de bord non demande par V1. resolveMarket() lit le
// GlobalState via getGlobalState() (Postgres) cote allowliste, jamais
// store.global. /contract est la MEME categorie GLOBAL-ONLY que /market --
// verifie a l'audit : commandContract ne lit AUCUNE donnee Player, seulement
// store.global.contract (cropId/required/bonusMultiplier/remaining) et
// cropById() (constants.ts) pour le nom/emoji de la culture. renewedAt
// n'est PAS affiche (le texte "Toutes les 4 heures" est statique, meme
// convention que le texte statique de /market). resolveContract() n'appelle
// donc jamais le bootstrap ensurePlayerExists non plus, exactement comme
// resolveMarket(). Ne s'applique JAMAIS a /leaderboard, etc. -- ces
// commandes restent V1 pour absolument tout le monde, allowliste ou non, et
// continuent donc de declencher ce preambule exactement comme avant.
const POSTGRES_ROUTED_COMMAND_NAMES = new Set([
  "buy",
  "daily",
  "plant",
  "craft",
  "harvest",
  "sell",
  "inventory",
  "farm",
  "profile",
  "market",
  "contract",
]);

export function commandSkipsJsonPreamble(
  commandName: string,
  playerId: string,
  deps: { shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime } = { shouldUsePostgresRuntime },
): boolean {
  return POSTGRES_ROUTED_COMMAND_NAMES.has(commandName) && deps.shouldUsePostgresRuntime(playerId);
}

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  try {
    if (
      !commandSkipsJsonPreamble(interaction.commandName, interaction.user.id) &&
      enrichGlobalState(store.global)
    ) {
      await store.save();
    }
    switch (interaction.commandName) {
      case "list":
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3f6b2f)
              .setTitle("Mini-jeux disponibles")
              .setDescription(
                MINI_GAMES.map((game) => `**${game.name}**\n${game.description}`).join("\n\n"),
              ),
          ],
        });
        return;
      case "plant":
        await commandPlant(interaction, store);
        return;
      case "farm":
        await commandFarm(interaction, store);
        return;
      case "harvest":
        await commandHarvest(interaction, store);
        return;
      case "inventory":
        await commandInventory(interaction, store);
        return;
      case "sell":
        await commandSell(interaction, store);
        return;
      case "market":
        await commandMarket(interaction, store);
        return;
      case "buy":
        await commandBuy(interaction, store);
        return;
      case "craft":
        await commandCraft(interaction, store);
        return;
      case "contract":
        await commandContract(interaction, store);
        return;
      case "profile":
        await commandProfile(interaction, store);
        return;
      case "leaderboard":
        await commandLeaderboard(interaction, store);
        return;
      case "weekly":
        await commandWeekly(interaction, store);
        return;
      case "daily":
        await commandDaily(interaction, store);
        return;
      case "codex":
        await commandCodex(interaction, store);
        return;
      default:
        throw new FarmError("Commande inconnue.");
    }
  } catch (error) {
    await replyError(interaction, error);
  }
}

// LOT 6, bascule TEST-only pour /plant UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme extraction PURE-DEPS que
// resolveBuyUpgrade/resolveDailyClaim ci-dessus. Contrairement a ces deux
// autres commandes, la reponse Discord de /plant a besoin d'une DEUXIEME
// donnee en plus du resultat de la mutation elle-meme : le temps de pousse
// affiche (growMinutes(), farm.ts) depend de player.irrigationLevel, pas
// du tout retourne par la plantation cote Postgres (qui ne retourne que le
// numero de parcelle, comme plant() lui-meme en V1). Cote V1, ce besoin existait
// deja et etait couvert par un second store.getPlayer() (lecture en
// memoire, gratuite). Cote Postgres, la MEME solution est reprise a
// l'identique avec le REPOSITORY existant (getPlayer() de
// farmRepository.ts, deja utilise ailleurs, LECTURE SEULE) plutot que
// FarmStore -- aucune nouvelle primitive, aucune regle metier dupliquee :
// growMinutes() est appele UNE SEULE fois, sur l'etat complet du joueur
// (V1 ou Postgres), exactement comme avant.
export interface PlantResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  plantPlayerCrop: typeof plantPlayerCrop;
  getPlayer: typeof getPlayer;
}

const realPlantResolutionDeps: PlantResolutionDeps = {
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  plantPlayerCrop,
  getPlayer,
};

export interface PlantResult {
  plantedPlot: number;
  player: PlayerState;
}

/**
 * Decide quel backend utiliser pour /plant et retourne le numero de
 * parcelle PLUS l'etat complet du joueur apres plantation (necessaire pour
 * growMinutes() dans commandPlant), SANS jamais toucher a la reponse
 * Discord. Un joueur allowliste passe EXCLUSIVEMENT par le bootstrap PUIS
 * la plantation cote Postgres, puis une relecture read-only via le
 * repository -- aucune ecriture JSON dans cette branche. Un joueur non
 * allowliste (cas par defaut) suit EXACTEMENT le chemin V1 : store.mutatePlayer
 * + plant(), puis store.getPlayer() pour la meme raison qu'avant.
 */
export async function resolvePlantCrop(
  playerId: string,
  cropId: CropId,
  requestedPlot: number | null,
  store: FarmStore,
  deps: PlantResolutionDeps = realPlantResolutionDeps,
): Promise<PlantResult> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    await deps.ensurePlayerExists(playerId);
    const plantedPlot = await deps.plantPlayerCrop(playerId, cropId, requestedPlot);
    const player = await deps.getPlayer(playerId);
    if (!player) {
      throw new Error(
        `resolvePlantCrop : joueur "${playerId}" introuvable juste apres la plantation -- etat incoherent.`,
      );
    }
    return { plantedPlot, player };
  }
  let plantedPlot = 0;
  await store.mutatePlayer(playerId, (player) => {
    plantedPlot = plant(player, cropId, requestedPlot);
  });
  const player = store.getPlayer(playerId);
  return { plantedPlot, player };
}

async function commandPlant(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const cropId = cropIdFrom(interaction.options.getString("culture", true));
  const requestedPlot = interaction.options.getInteger("parcelle") ?? null;
  const { plantedPlot, player } = await resolvePlantCrop(interaction.user.id, cropId, requestedPlot, store);
  const crop = cropById(cropId);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x3f6b2f)
        .setTitle("Culture plantée")
        .setDescription(
          `${crop.emoji} **${crop.name}** pousse sur la parcelle **${plantedPlot}**.\n` +
            `Récolte dans environ **${formatDuration(growMinutes(player, cropId))}**.`,
        ),
    ],
  });
}

// LOT 6, bascule TEST-only pour /farm UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme extraction PURE-DEPS que
// resolveInventory ci-dessus, et meme categorie qu'elle : /farm est
// PUREMENT LECTURE SEULE (aucune fonction mutante de farm.ts impliquee),
// donc ni mutatePlayer() ni mutatePlayerAndGlobal() ne sont utilises ici --
// seulement les lectures deja existantes getPlayer()/getGlobalState() de
// farmRepository.ts. Le temps restant/statut pret (growMinutes()/isReady()/
// growthPercent(), verifie a l'audit) ne depend QUE du PlayerState
// (plots, irrigationLevel) -- jamais du GlobalState. La ligne meteo est la
// SEULE donnee affichee qui depend du GlobalState : resolveFarmView() lit
// ce GlobalState via getGlobalState() (Postgres) cote allowliste, jamais
// store.global (JSON), qui pourrait diverger de l'etat Postgres reellement
// affiche a un joueur allowliste -- exactement la meme precaution que pour
// /harvest, /sell et /inventory.
export interface FarmViewResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  getPlayer: typeof getPlayer;
  getGlobalState: typeof getGlobalState;
}

const realFarmViewResolutionDeps: FarmViewResolutionDeps = {
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  getPlayer,
  getGlobalState,
};

export interface FarmViewResolutionResult {
  player: PlayerState;
  global: GlobalState;
}

/**
 * Decide quel backend utiliser pour /farm et retourne le PlayerState PLUS
 * le GlobalState a utiliser pour l'affichage (meteo), SANS jamais toucher a
 * la reponse Discord. Un joueur allowliste passe EXCLUSIVEMENT par le
 * bootstrap PUIS une lecture Postgres (getPlayer()/getGlobalState()) --
 * aucune ecriture, ni joueur ni globale. Un joueur non allowliste (cas par
 * defaut) suit EXACTEMENT le chemin V1 : store.getPlayer()/store.global.
 */
export async function resolveFarmView(
  playerId: string,
  store: FarmStore,
  deps: FarmViewResolutionDeps = realFarmViewResolutionDeps,
): Promise<FarmViewResolutionResult> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    await deps.ensurePlayerExists(playerId);
    const player = await deps.getPlayer(playerId);
    if (!player) {
      throw new Error(`resolveFarmView : joueur ${playerId} introuvable apres ensurePlayerExists.`);
    }
    const global = await deps.getGlobalState();
    if (!global) {
      throw new Error("resolveFarmView : global_state introuvable.");
    }
    return { player, global };
  }
  return { player: store.getPlayer(playerId), global: store.global };
}

async function commandFarm(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const { player, global } = await resolveFarmView(interaction.user.id, store);
  const now = Date.now();
  const plots = player.plots.map((plot, index) => {
    if (!plot.cropId) return `**${index + 1}** · 🟫 Parcelle libre`;
    const crop = cropById(plot.cropId);
    const ready = isReady(player, index, now);
    const percent = growthPercent(player, index, now);
    const status = ready ? "✅ Prête à récolter" : `${progressBar(percent)} ${percent}%`;
    return `**${index + 1}** · ${crop.emoji} ${crop.name} — ${status}`;
  });
  const readyCount = player.plots.filter((_plot, index) => isReady(player, index, now)).length;
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x3f6b2f)
        .setTitle(`🌾 Ferme de ${playerName(interaction)}`)
        .setDescription(plots.join("\n") || "Aucune parcelle.")
        .addFields(
          { name: "Météo actuelle", value: weatherLineForGlobal(global), inline: true },
          { name: "Prêtes", value: `${readyCount}/${player.plots.length}`, inline: true },
          { name: "Replantation auto", value: player.autoReplant ? "Activée" : "Désactivée", inline: true },
        )
        .setFooter({ text: "Utilise /harvest pour récolter tout ce qui est prêt." }),
    ],
  });
}

// LOT 6, bascule TEST-only pour /harvest UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme extraction PURE-DEPS que
// resolveBuyUpgrade/resolveDailyClaim/resolvePlantCrop/resolveCraftItem
// ci-dessus. Contrairement aux quatre autres, /harvest a besoin d'une
// PRIMITIVE DIFFERENTE (mutatePlayerAndGlobal(), via la fonction dediee
// harvestPlayerCrops de farmPlayerActions.ts) car harvest() (../farm.ts)
// mute a la fois le joueur ET l'etat global (daily_challenge) -- verifie a
// l'audit : cette fonction reutilise harvest() telle quelle, aucune regle
// dupliquee. La reponse Discord a besoin, comme pour /plant, d'une DONNEE
// SUPPLEMENTAIRE au-dela du HarvestResult : la meteo affichee
// (weatherLineForGlobal, format partage) doit provenir du MEME GlobalState que celui
// reellement utilise pour calculer le rendement (global.weatherMultiplier,
// lu par harvest() lui-meme) -- jamais de store.global (JSON) pour un
// joueur allowliste, qui pourrait diverger de l'etat Postgres reellement
// utilise pour le calcul. C'est pourquoi resolveHarvestCrops() retourne le
// GlobalState complet en plus du HarvestResult, dans les DEUX branches.
export interface HarvestResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  harvestPlayerCrops: typeof harvestPlayerCrops;
}

const realHarvestResolutionDeps: HarvestResolutionDeps = {
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  harvestPlayerCrops,
};

export interface HarvestResolutionResult {
  result: ReturnType<typeof harvest>;
  global: GlobalState;
}

/**
 * Decide quel backend utiliser pour /harvest et retourne le HarvestResult
 * PLUS le GlobalState reellement utilise pour le calcul (necessaire pour
 * la meteo affichee dans commandHarvest), SANS jamais toucher a la reponse
 * Discord. Un joueur allowliste passe EXCLUSIVEMENT par le bootstrap PUIS
 * la recolte cote Postgres (mutatePlayerAndGlobal, jamais store.mutatePlayer
 * ni store.save) -- le controle "aucune parcelle prete" reste dans
 * commandHarvest (comme en V1), pas ici. Un joueur non allowliste (cas par
 * defaut) suit EXACTEMENT le chemin V1 : store.mutatePlayer + harvest(player,
 * store.global), meme mutation du global JSON qu'avant.
 */
export async function resolveHarvestCrops(
  playerId: string,
  store: FarmStore,
  deps: HarvestResolutionDeps = realHarvestResolutionDeps,
): Promise<HarvestResolutionResult> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    await deps.ensurePlayerExists(playerId);
    return deps.harvestPlayerCrops(playerId);
  }
  let result: ReturnType<typeof harvest> | undefined;
  await store.mutatePlayer(playerId, (player) => {
    result = harvest(player, store.global);
  });
  return { result: result!, global: store.global };
}

async function commandHarvest(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const { result, global } = await resolveHarvestCrops(interaction.user.id, store);
  if (!result.harvested.length) {
    throw new FarmError("Aucune parcelle n'est prête pour le moment.");
  }
  const lines = result.harvested.map((entry) => {
    const crop = cropById(entry.cropId);
    return `${crop.emoji} **${crop.name}** ×${entry.amount} · +${entry.xp} XP${entry.replanted ? " · 🔁 replantée" : ""}`;
  });
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xe3a72f)
        .setTitle("Récolte terminée")
        .setDescription(lines.join("\n"))
        .addFields(
          { name: "XP gagnée", value: `+${result.totalXp}`, inline: true },
          { name: "Niveau", value: `${result.leveledUpTo}`, inline: true },
          { name: "Météo", value: weatherLineForGlobal(global), inline: true },
        ),
    ],
  });
}

// LOT 6, bascule TEST-only pour /inventory UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme extraction PURE-DEPS que les
// resolveXxx ci-dessus, mais /inventory est PUREMENT LECTURE SEULE : aucune
// fonction mutante de farm.ts n'est impliquee, donc ni mutatePlayer() ni
// mutatePlayerAndGlobal() ne sont utilises ici -- seulement les lectures
// deja existantes getPlayer()/getGlobalState() de farmRepository.ts. /inventory
// depend neanmoins du GlobalState (marketMultiplier, via currentCropPrice()
// pour le prix des cultures) : resolveInventory() lit ce GlobalState via
// getGlobalState() (Postgres) cote allowliste, jamais store.global (JSON),
// qui pourrait diverger de l'etat Postgres reellement affiche a un joueur
// allowliste -- exactement la meme precaution que pour /harvest et /sell.
export interface InventoryResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  getPlayer: typeof getPlayer;
  getGlobalState: typeof getGlobalState;
}

const realInventoryResolutionDeps: InventoryResolutionDeps = {
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  getPlayer,
  getGlobalState,
};

export interface InventoryResolutionResult {
  player: PlayerState;
  global: GlobalState;
}

/**
 * Decide quel backend utiliser pour /inventory et retourne le PlayerState
 * PLUS le GlobalState a utiliser pour l'affichage, SANS jamais toucher a la
 * reponse Discord. Un joueur allowliste passe EXCLUSIVEMENT par le
 * bootstrap PUIS une lecture Postgres (getPlayer()/getGlobalState()) --
 * aucune ecriture, ni joueur ni globale. Un joueur non allowliste (cas par
 * defaut) suit EXACTEMENT le chemin V1 : store.getPlayer()/store.global.
 */
export async function resolveInventory(
  playerId: string,
  store: FarmStore,
  deps: InventoryResolutionDeps = realInventoryResolutionDeps,
): Promise<InventoryResolutionResult> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    await deps.ensurePlayerExists(playerId);
    const player = await deps.getPlayer(playerId);
    if (!player) {
      throw new Error(`resolveInventory : joueur ${playerId} introuvable apres ensurePlayerExists.`);
    }
    const global = await deps.getGlobalState();
    if (!global) {
      throw new Error("resolveInventory : global_state introuvable.");
    }
    return { player, global };
  }
  return { player: store.getPlayer(playerId), global: store.global };
}

async function commandInventory(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const { player, global } = await resolveInventory(interaction.user.id, store);
  const lines = [...CROPS, ...RECIPES]
    .map((item) => {
      const amount = player.inventory[item.id] ?? 0;
      const value = "sellPrice" in item
        ? amount * item.sellPrice
        : amount * currentCropPrice(global, item.id);
      return `${item.emoji} **${item.name}** · ×${amount} · valeur ${formatCoins(value)}`;
    })
    .filter((line, index) => (player.inventory[[...CROPS, ...RECIPES][index].id] ?? 0) > 0 || line.includes("×0"));
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5b3c96)
        .setTitle("Inventaire Farm2Win")
        .setDescription(lines.join("\n"))
        .addFields({
          name: "Valeur totale estimée",
          value: formatCoins(totalInventoryValue(player, global)),
        }),
    ],
  });
}

// LOT 6, bascule TEST-only pour /sell UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme extraction PURE-DEPS que
// resolveHarvestCrops ci-dessus (meme primitive mutatePlayerAndGlobal(),
// via la fonction dediee sellPlayerItems de farmPlayerActions.ts, car sell() mute a la fois
// le joueur ET l'etat global (contract.remaining)). MEME PRECAUTION que
// pour /harvest (weatherLineForGlobal()) : la reponse Discord affiche
// "Contrat restant" -- cette valeur DOIT provenir du GlobalState
// REELLEMENT utilise par la vente, jamais de store.global (JSON), qui
// pourrait diverger de l'etat Postgres pour un joueur allowliste. C'est
// pourquoi resolveSellItems() retourne le GlobalState complet en plus du
// SellResult, dans les DEUX branches -- exactement comme resolveHarvestCrops.
export interface SellResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  sellPlayerItems: typeof sellPlayerItems;
}

const realSellResolutionDeps: SellResolutionDeps = {
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  sellPlayerItems,
};

export interface SellResolutionResult {
  result: ReturnType<typeof sell>;
  global: GlobalState;
}

/**
 * Decide quel backend utiliser pour /sell et retourne le SellResult PLUS
 * le GlobalState reellement utilise (necessaire pour "Contrat restant"
 * dans commandSell), SANS jamais toucher a la reponse Discord. Un joueur
 * allowliste passe EXCLUSIVEMENT par le bootstrap PUIS la vente cote
 * Postgres (mutatePlayerAndGlobal, jamais store.mutatePlayer ni
 * store.save). Un joueur non allowliste (cas par defaut) suit EXACTEMENT
 * le chemin V1 : store.mutatePlayer + sell(player, store.global, ...),
 * meme mutation du contract JSON qu'avant.
 */
export async function resolveSellItems(
  playerId: string,
  itemId: InventoryId | "all",
  requestedAmount: number | null,
  store: FarmStore,
  deps: SellResolutionDeps = realSellResolutionDeps,
): Promise<SellResolutionResult> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    await deps.ensurePlayerExists(playerId);
    return deps.sellPlayerItems(playerId, itemId, requestedAmount);
  }
  let result: ReturnType<typeof sell> | undefined;
  await store.mutatePlayer(playerId, (player) => {
    result = sell(player, store.global, itemId, requestedAmount);
  });
  return { result: result!, global: store.global };
}

async function commandSell(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const itemId = inventoryIdFrom(interaction.options.getString("culture", true));
  const requestedAmount = interaction.options.getInteger("quantite") ?? null;
  const { result, global } = await resolveSellItems(interaction.user.id, itemId, requestedAmount, store);
  if (!result) throw new FarmError("Vente impossible.");
  const lines = result.sold.map((entry) => {
    const item = [...CROPS, ...RECIPES].find((candidate) => candidate.id === entry.itemId);
    return `${item?.emoji ?? "📦"} ${item?.name ?? entry.itemId} ×${entry.amount} → ${formatCoins(entry.earned)}`;
  });
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xd29b32)
        .setTitle("Vente effectuée")
        .setDescription(lines.join("\n"))
        .addFields(
          { name: "Gains", value: formatCoins(result.earned), inline: true },
          { name: "Contrat restant", value: `${global.contract.remaining} unités`, inline: true },
        ),
    ],
  });
}

// LOT 6, bascule TEST-only pour /market UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme extraction PURE-DEPS que les
// resolveXxx ci-dessus, mais /market est GLOBAL-ONLY : contrairement a
// /inventory, /farm et /profile, commandMarket ne lit AUCUNE donnee Player
// (verifie a l'audit -- aucun store.getPlayer() dans son corps), seulement
// store.global. resolveMarket() n'appelle donc jamais le bootstrap
// ensurePlayerExists -- creer un joueur Postgres juste pour afficher le marche serait un
// effet de bord non demande par V1. Un joueur allowliste lit
// EXCLUSIVEMENT le GlobalState via getGlobalState() (Postgres), jamais
// store.global (JSON), qui pourrait diverger de l'etat Postgres reellement
// affiche. Si le GlobalState Postgres est absent, aucune tentative de
// fallback JSON silencieux : l'erreur remonte telle quelle (meme
// convention que farmRepository.ts, qui traite un global_state manquant
// comme un etat incoherent de la base).
export interface MarketResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  getGlobalState: typeof getGlobalState;
}

const realMarketResolutionDeps: MarketResolutionDeps = {
  shouldUsePostgresRuntime,
  getGlobalState,
};

/**
 * Decide quel backend utiliser pour /market et retourne le GlobalState a
 * utiliser pour l'affichage, SANS jamais toucher a la reponse Discord. Un
 * joueur allowliste lit EXCLUSIVEMENT le GlobalState Postgres -- aucune
 * ecriture, aucun bootstrap joueur (non necessaire, /market ne lit aucune
 * donnee Player). Un joueur non allowliste (cas par defaut) suit
 * EXACTEMENT le chemin V1 : store.global.
 */
export async function resolveMarket(
  playerId: string,
  store: FarmStore,
  deps: MarketResolutionDeps = realMarketResolutionDeps,
): Promise<GlobalState> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    const global = await deps.getGlobalState();
    if (!global) {
      throw new Error("resolveMarket : global_state introuvable.");
    }
    return global;
  }
  return store.global;
}

async function commandMarket(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const global = await resolveMarket(interaction.user.id, store);
  const direction = global.marketMultiplier > global.previousMarketMultiplier
    ? "📈"
    : global.marketMultiplier < global.previousMarketMultiplier ? "📉" : "➖";
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xd29b32)
        .setTitle("Marché Farm2Win")
        .setDescription(
          `Multiplicateur global : **×${global.marketMultiplier.toFixed(2)}** ${direction}\n` +
            `Prochaine mise à jour automatique dans moins de 30 minutes.`,
        )
        .addFields(
          ...CROPS.map((crop) => ({
            name: `${crop.emoji} ${crop.name}`,
            value: `${currentCropPrice(global, crop.id)} pièces`,
            inline: true,
          })),
        ),
    ],
  });
}

// LOT 6, bascule TEST-only pour /buy UNIQUEMENT (voir postgresRuntimeAllowlist.ts) --
// extrait de commandBuy en fonction PURE-DEPS injectable pour rester
// testable sans construire de fausse interaction discord.js : seule la
// DECISION (quel backend, quel resultat) vit ici, le parsing des options et
// la reponse Discord restent dans commandBuy, inchanges pour les deux
// branches.
export interface BuyResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  buyPlayerUpgrade: typeof buyPlayerUpgrade;
}

const realBuyResolutionDeps: BuyResolutionDeps = {
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  buyPlayerUpgrade,
};

/**
 * Decide quel backend utiliser pour /buy et retourne le resultat, SANS
 * jamais toucher a la reponse Discord (voir commandBuy). Un joueur
 * allowliste (deps.shouldUsePostgresRuntime === true) passe EXCLUSIVEMENT
 * par le bootstrap PUIS l'achat cote Postgres -- aucune ecriture JSON
 * (store.mutatePlayer/store.save) n'est jamais tentee dans cette branche.
 * Un joueur non allowliste (le cas par defaut, y compris quand
 * FARM2WIN_POSTGRES_TEST_PLAYER_IDS est absente) suit EXACTEMENT le chemin
 * V1 deja existant : store.mutatePlayer + buyUpgrade(), meme erreur
 * ("Achat impossible.") propagee telle quelle si buyUpgrade() ne mute rien.
 */
export async function resolveBuyUpgrade(
  playerId: string,
  kind: "plots" | "irrigation" | "fertilizer",
  quantity: number,
  store: FarmStore,
  deps: BuyResolutionDeps = realBuyResolutionDeps,
): Promise<{ bought: number; spent: number }> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    await deps.ensurePlayerExists(playerId);
    return deps.buyPlayerUpgrade(playerId, kind, quantity);
  }
  let result: ReturnType<typeof buyUpgrade> | undefined;
  await store.mutatePlayer(playerId, (player) => {
    result = buyUpgrade(player, kind, quantity);
  });
  if (!result) throw new FarmError("Achat impossible.");
  return result;
}

async function commandBuy(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const kind = interaction.options.getString("amelioration", true) as "plots" | "irrigation" | "fertilizer";
  const quantity = interaction.options.getInteger("quantite") ?? 1;
  const result = await resolveBuyUpgrade(interaction.user.id, kind, quantity, store);
  const labels = { plots: "parcelle(s)", irrigation: "niveau(x) d'irrigation", fertilizer: "niveau(x) d'engrais" };
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x4f86c6)
        .setTitle("Amélioration achetée")
        .setDescription(`Tu as acheté **${result.bought} ${labels[kind]}**.`)
        .addFields({ name: "Dépensé", value: formatCoins(result.spent) }),
    ],
  });
}

// LOT 6, bascule TEST-only pour /craft UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme extraction PURE-DEPS que
// resolveBuyUpgrade/resolveDailyClaim/resolvePlantCrop ci-dessus. La plus
// simple des quatre : contrairement a /plant, la reponse Discord n'a besoin
// d'AUCUNE seconde lecture -- `quantity` (l'entree elle-meme) suffit deja
// a l'affichage, exactement comme le fait deja commandCraft en V1 (le
// retour de craft() n'est meme pas capture aujourd'hui : craft() est
// all-or-nothing, donc un succes garantit crafted === quantity).
export interface CraftResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  craftPlayerItem: typeof craftPlayerItem;
}

const realCraftResolutionDeps: CraftResolutionDeps = {
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  craftPlayerItem,
};

/**
 * Decide quel backend utiliser pour /craft et retourne la quantite
 * fabriquee, SANS jamais toucher a la reponse Discord (voir commandCraft).
 * Un joueur allowliste passe EXCLUSIVEMENT par le bootstrap PUIS la
 * fabrication cote Postgres -- aucune ecriture JSON dans cette branche. Un
 * joueur non allowliste (cas par defaut) suit EXACTEMENT le chemin V1 :
 * store.mutatePlayer + craft(), meme erreur (ingredients insuffisants,
 * quantite hors bornes) propagee telle quelle.
 */
export async function resolveCraftItem(
  playerId: string,
  recipeId: ProductId,
  quantity: number,
  store: FarmStore,
  deps: CraftResolutionDeps = realCraftResolutionDeps,
): Promise<number> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    await deps.ensurePlayerExists(playerId);
    return deps.craftPlayerItem(playerId, recipeId, quantity);
  }
  await store.mutatePlayer(playerId, (player) => {
    craft(player, recipeId, quantity);
  });
  return quantity;
}

async function commandCraft(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const recipeId = productIdFrom(interaction.options.getString("recette", true));
  const quantity = interaction.options.getInteger("quantite") ?? 1;
  await resolveCraftItem(interaction.user.id, recipeId, quantity, store);
  const recipe = recipeById(recipeId);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xc17745)
        .setTitle("Transformation réussie")
        .setDescription(`${recipe.emoji} Tu as fabriqué **${quantity} ${recipe.name}**.`)
        .addFields({ name: "Prix de vente unitaire", value: formatCoins(recipe.sellPrice) }),
    ],
  });
}

// LOT 6, bascule TEST-only pour /contract UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme categorie GLOBAL-ONLY que
// resolveMarket ci-dessus : commandContract ne lit AUCUNE donnee Player
// (verifie a l'audit -- aucun store.getPlayer() dans son corps), seulement
// store.global.contract. resolveContract() n'accepte donc meme pas
// ensurePlayerExists/getPlayer dans ses deps -- aucun bootstrap joueur ne
// doit jamais avoir lieu pour /contract, allowliste ou non. Un joueur
// allowliste lit EXCLUSIVEMENT le GlobalState via getGlobalState()
// (Postgres), jamais store.global (JSON), qui pourrait diverger de l'etat
// Postgres reellement affiche. Si le GlobalState Postgres est absent,
// aucun fallback JSON silencieux : l'erreur remonte telle quelle (meme
// convention que resolveMarket()).
export interface ContractResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  getGlobalState: typeof getGlobalState;
}

const realContractResolutionDeps: ContractResolutionDeps = {
  shouldUsePostgresRuntime,
  getGlobalState,
};

/**
 * Decide quel backend utiliser pour /contract et retourne le GlobalState a
 * utiliser pour l'affichage, SANS jamais toucher a la reponse Discord. Un
 * joueur allowliste lit EXCLUSIVEMENT le GlobalState Postgres -- aucune
 * ecriture, aucun bootstrap joueur (non necessaire, /contract ne lit aucune
 * donnee Player). Un joueur non allowliste (cas par defaut) suit
 * EXACTEMENT le chemin V1 : store.global.
 */
export async function resolveContract(
  playerId: string,
  store: FarmStore,
  deps: ContractResolutionDeps = realContractResolutionDeps,
): Promise<GlobalState> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    const global = await deps.getGlobalState();
    if (!global) {
      throw new Error("resolveContract : global_state introuvable.");
    }
    return global;
  }
  return store.global;
}

async function commandContract(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const global = await resolveContract(interaction.user.id, store);
  const contract = global.contract;
  const crop = cropById(contract.cropId);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x8a6420)
        .setTitle("Contrat spécial")
        .setDescription(
          `Fournis **${contract.required} ${crop.name}** pour profiter d'un bonus de vente **×${contract.bonusMultiplier.toFixed(2)}**.`,
        )
        .addFields(
          { name: "Culture", value: `${crop.emoji} ${crop.name}`, inline: true },
          { name: "Reste à fournir", value: `${contract.remaining}`, inline: true },
          { name: "Renouvellement", value: "Toutes les 4 heures", inline: true },
        ),
    ],
  });
}

// LOT 6, bascule TEST-only pour /profile UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme extraction PURE-DEPS que
// resolveInventory/resolveFarmView ci-dessus, et meme categorie qu'elles :
// /profile est PUREMENT LECTURE SEULE (aucune fonction mutante de farm.ts
// impliquee), donc ni mutatePlayer() ni mutatePlayerAndGlobal() ne sont
// utilises ici -- seulement les lectures deja existantes getPlayer()/
// getGlobalState() de farmRepository.ts. commandProfile depend du
// GlobalState via totalInventoryValue(player, global) (marketMultiplier,
// verifie a l'audit) : resolveProfile() lit ce GlobalState via
// getGlobalState() (Postgres) cote allowliste, jamais store.global (JSON),
// qui pourrait diverger de l'etat Postgres reellement affiche a un joueur
// allowliste -- exactement la meme precaution que pour /inventory et /farm.
export interface ProfileResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  getPlayer: typeof getPlayer;
  getGlobalState: typeof getGlobalState;
}

const realProfileResolutionDeps: ProfileResolutionDeps = {
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  getPlayer,
  getGlobalState,
};

export interface ProfileResolutionResult {
  player: PlayerState;
  global: GlobalState;
}

/**
 * Decide quel backend utiliser pour /profile et retourne le PlayerState
 * PLUS le GlobalState a utiliser pour l'affichage (valeur d'inventaire),
 * SANS jamais toucher a la reponse Discord. Un joueur allowliste passe
 * EXCLUSIVEMENT par le bootstrap PUIS une lecture Postgres (getPlayer()/
 * getGlobalState()) -- aucune ecriture, ni joueur ni globale. Un joueur non
 * allowliste (cas par defaut) suit EXACTEMENT le chemin V1 :
 * store.getPlayer()/store.global.
 */
export async function resolveProfile(
  playerId: string,
  store: FarmStore,
  deps: ProfileResolutionDeps = realProfileResolutionDeps,
): Promise<ProfileResolutionResult> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    await deps.ensurePlayerExists(playerId);
    const player = await deps.getPlayer(playerId);
    if (!player) {
      throw new Error(`resolveProfile : joueur ${playerId} introuvable apres ensurePlayerExists.`);
    }
    const global = await deps.getGlobalState();
    if (!global) {
      throw new Error("resolveProfile : global_state introuvable.");
    }
    return { player, global };
  }
  return { player: store.getPlayer(playerId), global: store.global };
}

async function commandProfile(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const { player, global } = await resolveProfile(interaction.user.id, store);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x3f6b2f)
        .setTitle(`Profil de ${playerName(interaction)}`)
        .setDescription(`Niveau **${player.level}** · ${player.xp}/${xpToNextLevel(player.level)} XP`)
        .addFields(
          { name: "Pièces", value: formatCoins(player.coins), inline: true },
          { name: "Parcelles", value: `${player.plots.length}/40`, inline: true },
          { name: "Irrigation", value: `${player.irrigationLevel}/15`, inline: true },
          { name: "Engrais", value: `${player.fertilizerLevel}/20`, inline: true },
          { name: "Inventaire", value: formatCoins(totalInventoryValue(player, global)), inline: true },
          { name: "Replantation auto", value: player.autoReplant ? "ON" : "OFF", inline: true },
        ),
    ],
  });
}

async function commandLeaderboard(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const top = [...store.getPlayers()]
    .sort((a, b) => (b.coins + totalInventoryValue(b, store.global)) - (a.coins + totalInventoryValue(a, store.global)))
    .slice(0, 10);
  const lines = await Promise.all(top.map(async (player, index) => {
    const user = await interaction.client.users.fetch(player.userId).catch(() => null);
    const medal = ["🥇", "🥈", "🥉"][index] ?? `**${index + 1}.**`;
    const wealth = player.coins + totalInventoryValue(player, store.global);
    return `${medal} ${user?.username ?? player.userId} — **${formatCoins(wealth)}**`;
  }));
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xd29b32)
        .setTitle("Top 10 · richesse totale")
        .setDescription(lines.join("\n") || "Le classement est encore vide."),
    ],
  });
}

async function commandWeekly(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const top = [...store.getPlayers()]
    .sort((a, b) => (b.coins - b.weeklySnapshotCoins) - (a.coins - a.weeklySnapshotCoins))
    .slice(0, 10);
  const lines = await Promise.all(top.map(async (player, index) => {
    const user = await interaction.client.users.fetch(player.userId).catch(() => null);
    const medal = ["🥇", "🥈", "🥉"][index] ?? `**${index + 1}.**`;
    return `${medal} ${user?.username ?? player.userId} — **${formatCoins(player.coins - player.weeklySnapshotCoins)}** gagnées`;
  }));
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5b3c96)
        .setTitle("Classement hebdomadaire")
        .setDescription(lines.join("\n") || "Le classement est encore vide.")
        .setFooter({ text: "Récompenses : 500 · 300 · 150 pièces pour le podium." }),
    ],
  });
}

// LOT 6, bascule TEST-only pour /daily UNIQUEMENT (voir
// postgresRuntimeAllowlist.ts) -- meme extraction PURE-DEPS que
// resolveBuyUpgrade ci-dessus, pour rester testable sans fausse
// interaction discord.js.
export interface DailyResolutionDeps {
  shouldUsePostgresRuntime: typeof shouldUsePostgresRuntime;
  ensurePlayerExists: typeof ensurePlayerExists;
  claimPlayerDaily: typeof claimPlayerDaily;
}

const realDailyResolutionDeps: DailyResolutionDeps = {
  shouldUsePostgresRuntime,
  ensurePlayerExists,
  claimPlayerDaily,
};

/**
 * Decide quel backend utiliser pour /daily et retourne la recompense, SANS
 * jamais toucher a la reponse Discord (voir commandDaily). Un joueur
 * allowliste passe EXCLUSIVEMENT par le bootstrap PUIS la reclamation cote
 * Postgres -- aucune ecriture JSON (store.mutatePlayer/store.save) dans cette
 * branche. Un joueur non allowliste (cas par defaut) suit EXACTEMENT le
 * chemin V1 : store.mutatePlayer + claimDaily(), meme cooldown/erreur
 * propagee telle quelle.
 */
export async function resolveDailyClaim(
  playerId: string,
  store: FarmStore,
  deps: DailyResolutionDeps = realDailyResolutionDeps,
): Promise<number> {
  if (deps.shouldUsePostgresRuntime(playerId)) {
    await deps.ensurePlayerExists(playerId);
    return deps.claimPlayerDaily(playerId);
  }
  let reward = 0;
  await store.mutatePlayer(playerId, (player) => {
    reward = claimDaily(player);
  });
  return reward;
}

async function commandDaily(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const reward = await resolveDailyClaim(interaction.user.id, store);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xe3a72f)
        .setTitle("Récompense quotidienne")
        .setDescription(`Tu reçois **${formatCoins(reward)}**. Reviens dans 20 heures.`),
    ],
  });
}

interface CodexViewState {
  userId: string;
  cropId: CropId;
  filter: string;
  simulatedPlots: number;
}

const codexViews = new Map<string, CodexViewState>();

function filteredCrops(filter: string) {
  if (filter === "all") return [...CROPS];
  const tier = TIER_INFO.find((candidate) => candidate.name === filter);
  return tier ? CROPS.filter((crop) => stageFor(crop.unlockLevel).name === tier.name) : [...CROPS];
}

function codexPayload(
  store: FarmStore,
  player: PlayerState,
  view: CodexViewState,
  feedback?: string,
): Pick<InteractionReplyOptions, "embeds" | "components"> {
  const crop = cropById(view.cropId);
  const tier = stageFor(crop.unlockLevel);
  const price = currentCropPrice(store.global, crop.id);
  const realMinutes = growMinutes(player, crop.id);
  const yieldPerPlot = Math.max(1, Math.round(crop.baseYield * (1 + player.fertilizerLevel * 0.05)) * store.global.weatherMultiplier);
  const totalCost = view.simulatedPlots * crop.seedCost;
  const totalHarvest = view.simulatedPlots * yieldPerPlot;
  const profit = totalHarvest * price - totalCost;
  const options = filteredCrops(view.filter).map((candidate) => ({
    label: `${candidate.emoji} ${candidate.name}`.slice(0, 100),
    value: candidate.id,
    default: candidate.id === crop.id,
  }));
  const filterOptions = [
    { label: "Tous les paliers", value: "all", default: view.filter === "all" },
    ...TIER_INFO.map((candidate) => ({
      label: candidate.name,
      value: candidate.name,
      default: view.filter === candidate.name,
    })),
  ];
  const embed = new EmbedBuilder()
    .setAuthor({ name: "CEDJEUX · CODEX FARM2WIN" })
    .setTitle(`${crop.emoji} ${crop.name}`)
    .setColor(tier.color)
    .setThumbnail(`https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/72x72/${[...crop.emoji].map((char) => char.codePointAt(0)?.toString(16)).filter(Boolean).join("-")}.png`)
    .setDescription(
      `Pousse : ${progressBar((crop.growMinutes / 60) * 100)} (${crop.growMinutes} min)\n` +
        `${tier.emoji} Palier ${tier.name} · niveau ${crop.unlockLevel}\n` +
        `Météo actuelle : ${weatherLine(store)}\n\n` +
        (feedback ? `**${feedback}**` : ""),
    )
    .addFields(
      { name: "COÛT GRAINE", value: `${crop.seedCost} pièces`, inline: true },
      { name: "PRIX DE VENTE", value: `${price} pièces`, inline: true },
      { name: invisible, value: invisible },
      { name: "TEMPS DE POUSSE", value: formatDuration(realMinutes), inline: true },
      { name: "RENDEMENT", value: `${yieldPerPlot} / parcelle`, inline: true },
      { name: invisible, value: invisible },
      { name: "XP GAGNÉE", value: `${crop.xp}`, inline: true },
      { name: "MARCHÉ", value: `×${store.global.marketMultiplier.toFixed(2)}`, inline: true },
      { name: invisible, value: invisible },
      {
        name: "Simulateur de récolte",
        value:
          `Parcelles : **${view.simulatedPlots}** · Coût total : **${formatCoins(totalCost)}**\n` +
          `Temps réel : **${formatDuration(realMinutes)}** · Récolte totale : **${totalHarvest}**\n` +
          `Profit estimé : **${formatCoins(profit)}**`,
      },
    )
    .setFooter({ text: `Parcelles libres : ${player.plots.filter((plot) => plot.cropId === null).length}` });

  const components = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`codex:culture:${view.userId}`)
        .setPlaceholder("Choisir une culture")
        .addOptions(options),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`codex:filter:${view.userId}`)
        .setPlaceholder("Filtrer par palier")
        .addOptions(filterOptions),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`codex:plant:${view.userId}`).setLabel("🌱 Planter cette culture").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`codex:refresh:${view.userId}`).setLabel("🔄 Actualiser le prix").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`codex:plots:down:${view.userId}`).setLabel("➖ Parcelles").setStyle(ButtonStyle.Secondary).setDisabled(view.simulatedPlots <= 0),
      new ButtonBuilder().setCustomId(`codex:plots:up:${view.userId}`).setLabel("➕ Parcelles").setStyle(ButtonStyle.Secondary).setDisabled(view.simulatedPlots >= player.plots.filter((plot) => plot.cropId === null).length),
      new ButtonBuilder().setCustomId(`codex:replant:${view.userId}`).setLabel(`🔁 Replantation auto : ${player.autoReplant ? "ON" : "OFF"}`).setStyle(ButtonStyle.Primary),
    ),
  ];
  return { embeds: [embed], components };
}

async function commandCodex(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  if (!interaction.guild) throw new FarmError("Le Codex doit être utilisé dans un serveur.");
  const me = interaction.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new FarmError("Le bot doit avoir la permission « Gérer les salons ».");
  }
  const category =
    interaction.guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === "🌾 Farm2Win",
    ) ??
    await interaction.guild.channels.create({
      name: "🌾 Farm2Win",
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] },
      ],
    });
  const channelName =
    `farm-${interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 80) || interaction.user.id}`;
  const existing = interaction.guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.parentId === category.id &&
      channel.name === channelName &&
      channel.permissionOverwrites.cache.has(interaction.user.id),
  );
  if (existing) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x3f6b2f)
          .setTitle("Ton Codex Farm2Win existe déjà")
          .setDescription(`[Ouvrir le salon privé](${existing.url})`),
      ],
      ephemeral: true,
    });
    return;
  }
  const channel = await interaction.guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    ],
  });
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x3f6b2f)
        .setTitle("Codex Farm2Win créé")
        .setDescription(`[Ouvrir ton salon privé](${channel.url})`),
    ],
    ephemeral: true,
  });
  const player = store.getPlayer(interaction.user.id);
  const view: CodexViewState = {
    userId: interaction.user.id,
    cropId: "wheat",
    filter: "all",
    simulatedPlots: player.plots.filter((plot) => plot.cropId === null).length,
  };
  const payload = codexPayload(store, player, view);
  const message = await channel.send({
    embeds: payload.embeds,
    components: payload.components,
  });
  codexViews.set(message.id, view);
}

export async function handleCodexComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  store: FarmStore,
): Promise<void> {
  try {
    const parts = interaction.customId.split(":");
    if (parts[0] !== "codex" || parts.length < 3) return;
    const userId = parts[parts.length - 1];
    if (userId !== interaction.user.id) {
      await interaction.reply({ embeds: [embedError(new FarmError("Ce Codex appartient à un autre joueur."))], ephemeral: true });
      return;
    }
    const view = codexViews.get(interaction.message.id) ?? {
      userId,
      cropId: "wheat" as CropId,
      filter: "all",
      simulatedPlots: store.getPlayer(userId).plots.filter((plot) => plot.cropId === null).length,
    };
    const player = store.getPlayer(userId);
    let feedback: string | undefined;
    if (interaction.isStringSelectMenu()) {
      if (parts[1] === "culture") view.cropId = cropIdFrom(interaction.values[0] ?? "wheat");
      if (parts[1] === "filter") {
        view.filter = interaction.values[0] ?? "all";
        const options = filteredCrops(view.filter);
        if (!options.some((crop) => crop.id === view.cropId)) view.cropId = options[0]?.id ?? "wheat";
      }
    } else if (parts[1] === "plant") {
      const plot = plant(player, view.cropId, null);
      player.updatedAt = Date.now();
      await store.save();
      feedback = `Culture plantée sur la parcelle ${plot}.`;
    } else if (parts[1] === "refresh") {
      const changed = enrichGlobalState(store.global);
      if (changed) await store.save();
      feedback = changed ? "Prix et événements actualisés." : "Prix déjà à jour.";
    } else if (parts[1] === "plots") {
      const freePlots = player.plots.filter((plot) => plot.cropId === null).length;
      view.simulatedPlots = Math.max(0, Math.min(freePlots, view.simulatedPlots + (parts[2] === "up" ? 1 : -1)));
    } else if (parts[1] === "replant") {
      player.autoReplant = !player.autoReplant;
      player.updatedAt = Date.now();
      await store.save();
      feedback = `Replantation automatique ${player.autoReplant ? "activée" : "désactivée"}.`;
    }
    codexViews.set(interaction.message.id, view);
    await interaction.update(codexPayload(store, player, view, feedback));
  } catch (error) {
    await replyError(interaction, error);
  }
}