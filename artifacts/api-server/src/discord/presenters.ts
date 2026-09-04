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
import { buyPlayerUpgrade } from "./db/farmPlayerActions.ts";
import { ensurePlayerExists } from "./db/farmRepository.ts";
import { shouldUsePostgresRuntime } from "./postgresRuntimeAllowlist.ts";
import type {
  CropId,
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

function weatherLine(store: FarmStore): string {
  const weather = WEATHER_INFO[store.global.weather];
  return `${weather.emoji} ${weather.label} · rendement ×${weather.multiplier}`;
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

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  try {
    if (enrichGlobalState(store.global)) await store.save();
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

async function commandPlant(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const cropId = cropIdFrom(interaction.options.getString("culture", true));
  const requestedPlot = interaction.options.getInteger("parcelle") ?? null;
  let plantedPlot = 0;
  await store.mutatePlayer(interaction.user.id, (player) => {
    plantedPlot = plant(player, cropId, requestedPlot);
  });
  const crop = cropById(cropId);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x3f6b2f)
        .setTitle("Culture plantée")
        .setDescription(
          `${crop.emoji} **${crop.name}** pousse sur la parcelle **${plantedPlot}**.\n` +
            `Récolte dans environ **${formatDuration(growMinutes(store.getPlayer(interaction.user.id), cropId))}**.`,
        ),
    ],
  });
}

async function commandFarm(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const player = store.getPlayer(interaction.user.id);
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
          { name: "Météo actuelle", value: weatherLine(store), inline: true },
          { name: "Prêtes", value: `${readyCount}/${player.plots.length}`, inline: true },
          { name: "Replantation auto", value: player.autoReplant ? "Activée" : "Désactivée", inline: true },
        )
        .setFooter({ text: "Utilise /harvest pour récolter tout ce qui est prêt." }),
    ],
  });
}

async function commandHarvest(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  let result: ReturnType<typeof harvest> | undefined;
  await store.mutatePlayer(interaction.user.id, (player) => {
    result = harvest(player, store.global);
  });
  if (!result?.harvested.length) {
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
          { name: "Météo", value: weatherLine(store), inline: true },
        ),
    ],
  });
}

async function commandInventory(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const player = store.getPlayer(interaction.user.id);
  const lines = [...CROPS, ...RECIPES]
    .map((item) => {
      const amount = player.inventory[item.id] ?? 0;
      const value = "sellPrice" in item
        ? amount * item.sellPrice
        : amount * currentCropPrice(store.global, item.id);
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
          value: formatCoins(totalInventoryValue(player, store.global)),
        }),
    ],
  });
}

async function commandSell(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const itemId = inventoryIdFrom(interaction.options.getString("culture", true));
  const requestedAmount = interaction.options.getInteger("quantite") ?? null;
  let result: ReturnType<typeof sell> | undefined;
  await store.mutatePlayer(interaction.user.id, (player) => {
    result = sell(player, store.global, itemId, requestedAmount);
  });
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
          { name: "Contrat restant", value: `${store.global.contract.remaining} unités`, inline: true },
        ),
    ],
  });
}

async function commandMarket(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const direction = store.global.marketMultiplier > store.global.previousMarketMultiplier
    ? "📈"
    : store.global.marketMultiplier < store.global.previousMarketMultiplier ? "📉" : "➖";
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xd29b32)
        .setTitle("Marché Farm2Win")
        .setDescription(
          `Multiplicateur global : **×${store.global.marketMultiplier.toFixed(2)}** ${direction}\n` +
            `Prochaine mise à jour automatique dans moins de 30 minutes.`,
        )
        .addFields(
          ...CROPS.map((crop) => ({
            name: `${crop.emoji} ${crop.name}`,
            value: `${currentCropPrice(store.global, crop.id)} pièces`,
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

async function commandCraft(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const recipeId = productIdFrom(interaction.options.getString("recette", true));
  const quantity = interaction.options.getInteger("quantite") ?? 1;
  await store.mutatePlayer(interaction.user.id, (player) => {
    craft(player, recipeId, quantity);
  });
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

async function commandContract(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const contract = store.global.contract;
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

async function commandProfile(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  const player = store.getPlayer(interaction.user.id);
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
          { name: "Inventaire", value: formatCoins(totalInventoryValue(player, store.global)), inline: true },
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

async function commandDaily(
  interaction: ChatInputCommandInteraction,
  store: FarmStore,
): Promise<void> {
  let reward = 0;
  await store.mutatePlayer(interaction.user.id, (player) => {
    reward = claimDaily(player);
  });
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