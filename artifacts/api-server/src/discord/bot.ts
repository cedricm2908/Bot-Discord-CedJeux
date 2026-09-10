import {
  ApplicationCommandType,
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ApplicationCommandDataResolvable,
} from "discord.js";
import { logger } from "../lib/logger";
import {
  distributeDailyChallengeReward,
  enrichGlobalState,
  resetWeeklyIfNeeded,
} from "./farm";
import {
  CROPS,
  MAX_FERTILIZER,
  MAX_IRRIGATION,
  MAX_PLOTS,
  RECIPES,
} from "./constants";
import { getFarmStore } from "./sharedStore";
import type { FarmStore } from "./store";
import { handleCodexComponent, handleSlashCommand } from "./presenters";
import { cropById } from "./constants";
import { isReady } from "./farm";
import {
  buildRealPostgresSchedulerDeps,
  createPostgresSchedulerTickRunner,
  isPostgresSchedulerEnabled,
  type ReadyPlotNotification,
} from "./db/postgresScheduler";

const slashCommands = [
  new SlashCommandBuilder()
    .setName("list")
    .setDescription("Affiche les mini-jeux disponibles"),
  new SlashCommandBuilder()
    .setName("plant")
    .setDescription("Plante une culture sur une parcelle")
    .addStringOption((option) =>
      option
        .setName("culture")
        .setDescription("Culture à planter")
        .setRequired(true)
        .addChoices(...CROPS.map((crop) => ({ name: `${crop.emoji} ${crop.name}`, value: crop.id }))),
    )
    .addIntegerOption((option) =>
      option
        .setName("parcelle")
        .setDescription("Numéro de parcelle (optionnel)")
        .setMinValue(1)
        .setMaxValue(MAX_PLOTS),
    ),
  new SlashCommandBuilder().setName("farm").setDescription("Affiche l'état de tes parcelles"),
  new SlashCommandBuilder().setName("harvest").setDescription("Récolte toutes les cultures prêtes"),
  new SlashCommandBuilder().setName("inventory").setDescription("Affiche tes ressources et produits"),
  new SlashCommandBuilder()
    .setName("sell")
    .setDescription("Vend des ressources au prix du marché")
    .addStringOption((option) =>
      option
        .setName("culture")
        .setDescription("Ressource à vendre")
        .setRequired(true)
        .addChoices(
          { name: "📦 Tout vendre", value: "all" },
          ...CROPS.map((crop) => ({ name: `${crop.emoji} ${crop.name}`, value: crop.id })),
          ...RECIPES.map((recipe) => ({ name: `${recipe.emoji} ${recipe.name}`, value: recipe.id })),
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("quantite")
        .setDescription("Quantité (toute la pile par défaut)")
        .setMinValue(1),
    ),
  new SlashCommandBuilder().setName("market").setDescription("Affiche les prix et la tendance du marché"),
  new SlashCommandBuilder()
    .setName("buy")
    .setDescription("Achète des améliorations")
    .addStringOption((option) =>
      option
        .setName("amelioration")
        .setDescription("Amélioration à acheter")
        .setRequired(true)
        .addChoices(
          { name: `Parcelle (max ${MAX_PLOTS})`, value: "plots" },
          { name: `Irrigation (max ${MAX_IRRIGATION})`, value: "irrigation" },
          { name: `Engrais (max ${MAX_FERTILIZER})`, value: "fertilizer" },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName("quantite")
        .setDescription("Nombre de niveaux à acheter")
        .setMinValue(1)
        .setMaxValue(40),
    ),
  new SlashCommandBuilder()
    .setName("craft")
    .setDescription("Transforme tes cultures en produits")
    .addStringOption((option) =>
      option
        .setName("recette")
        .setDescription("Recette à fabriquer")
        .setRequired(true)
        .addChoices(...RECIPES.map((recipe) => ({ name: `${recipe.emoji} ${recipe.name}`, value: recipe.id }))),
    )
    .addIntegerOption((option) =>
      option.setName("quantite").setDescription("Quantité à fabriquer").setMinValue(1).setMaxValue(40),
    ),
  new SlashCommandBuilder().setName("contract").setDescription("Affiche ton contrat spécial"),
  new SlashCommandBuilder().setName("profile").setDescription("Affiche ton profil Farm2Win"),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Affiche le top 10 des plus riches"),
  new SlashCommandBuilder().setName("weekly").setDescription("Affiche le classement des gains de la semaine"),
  new SlashCommandBuilder().setName("daily").setDescription("Récupère ta récompense quotidienne"),
  new SlashCommandBuilder().setName("codex").setDescription("Crée ou ouvre ton Codex Farm2Win privé"),
].map((command) => command.toJSON());

async function registerCommands(client: Client): Promise<void> {
  if (!client.application) throw new Error("Application Discord indisponible.");
  const existing = await client.application.commands.fetch();
  const entryPoint = existing.find(
    (command) => command.type === ApplicationCommandType.PrimaryEntryPoint,
  );
  const commandsToSet: ApplicationCommandDataResolvable[] = entryPoint
    ? [entryPoint.toJSON() as ApplicationCommandDataResolvable, ...slashCommands]
    : [...slashCommands];
  await client.application.commands.set(commandsToSet);
  logger.info(
    {
      commands: commandsToSet.length,
      slashCommands: slashCommands.length,
      entryPointPreserved: Boolean(entryPoint),
    },
    "Discord slash commands registered",
  );
}

async function notifyReadyCrops(client: Client, store: FarmStore): Promise<void> {
  let changed = false;
  for (const player of store.getPlayers()) {
    const readyPlots = player.plots
      .map((plot, index) => ({ plot, index }))
      .filter(({ plot, index }) => Boolean(plot.cropId) && !plot.notifiedReady && isReady(player, index));
    if (!readyPlots.length) continue;
    const user = await client.users.fetch(player.userId).catch(() => null);
    if (!user) continue;
    try {
      await user.send({
        embeds: [
          {
            color: 0x3f6b2f,
            title: "🌾 Une récolte est prête",
            description: readyPlots
              .map(({ plot, index }) => `${cropById(plot.cropId!).emoji} ${cropById(plot.cropId!).name} · parcelle ${index + 1}`)
              .join("\n"),
            footer: { text: "Utilise /harvest pour récolter." },
          },
        ],
      });
      readyPlots.forEach(({ plot }) => {
        plot.notifiedReady = true;
        changed = true;
      });
    } catch (error) {
      logger.warn({ err: error, userId: player.userId }, "Unable to send crop-ready notification");
    }
  }
  if (changed) await store.save();
}

// LOT SCHEDULER 1 : callback d'envoi de DM injecte dans le scheduler
// PostgreSQL (postgresScheduler.ts), qui ne cree jamais son propre Client
// discord.js. Reutilise EXACTEMENT le meme contenu/format que
// notifyReadyCrops() ci-dessus (V1 JSON) -- meme titre, meme couleur, meme
// format de ligne par parcelle, meme footer -- aucun changement du contenu
// utilisateur. Ne catch PAS l'erreur ici : le scheduler (postgresScheduler.ts)
// est deja responsable de logger un echec d'envoi sans jamais exposer de
// playerId, et de ne jamais laisser cette erreur interrompre le tick.
function buildRealSendReadyNotification(
  client: Client,
): (playerId: string, readyPlots: ReadyPlotNotification[]) => Promise<void> {
  return async (playerId, readyPlots) => {
    const user = await client.users.fetch(playerId);
    await user.send({
      embeds: [
        {
          color: 0x3f6b2f,
          title: "🌾 Une récolte est prête",
          description: readyPlots
            .map(({ cropId, plotIndex }) => `${cropById(cropId).emoji} ${cropById(cropId).name} · parcelle ${plotIndex + 1}`)
            .join("\n"),
          footer: { text: "Utilise /harvest pour récolter." },
        },
      ],
    });
  };
}

export async function startDiscordBot(): Promise<void> {
  const store = await getFarmStore();
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_TOKEN absent : le serveur API démarre, mais le bot Discord reste en attente du Secret.");
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  });
  logger.info("Connecting CedJeux to Discord");

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      logger.info("Discord gateway ready; synchronizing CedJeux commands");
      const globalChanged = enrichGlobalState(store.global);
      const weeklyChanged = resetWeeklyIfNeeded(store);
      const challengeChanged = distributeDailyChallengeReward(store);
      if (globalChanged || weeklyChanged || challengeChanged) await store.save();
      await registerCommands(readyClient);
      readyClient.user.setActivity("Farm2Win · /list");
      logger.info({ tag: readyClient.user.tag, guilds: readyClient.guilds.cache.size }, "CedJeux Discord bot ready");
      await notifyReadyCrops(readyClient, store);
      setInterval(() => {
        void (async () => {
          const changed =
            enrichGlobalState(store.global) ||
            resetWeeklyIfNeeded(store) ||
            distributeDailyChallengeReward(store);
          if (changed) await store.save();
          await notifyReadyCrops(readyClient, store);
        })().catch((error) => logger.error({ err: error }, "Farm2Win scheduler failed"));
      }, 60_000);

      // LOT SCHEDULER 1 : scheduler PostgreSQL, COEXISTE avec le scheduler
      // JSON V1 ci-dessus (jamais un remplacement) -- positionne
      // volontairement APRES registerCommands()/setActivity()/
      // notifyReadyCrops()/l'enregistrement du setInterval JSON, et
      // toujours en fire-and-forget (jamais awaite ici) : un echec de ce
      // bloc ne peut donc jamais empecher ce qui precede, qui a deja
      // termine avec succes a ce stade. Desactive par defaut (fail-closed,
      // voir isPostgresSchedulerEnabled()) -- aucun effet si la variable
      // d'environnement n'est pas exactement "true".
      if (isPostgresSchedulerEnabled()) {
        const runPostgresSchedulerTick = createPostgresSchedulerTickRunner(
          buildRealPostgresSchedulerDeps(buildRealSendReadyNotification(readyClient)),
        );
        void runPostgresSchedulerTick().catch((error) =>
          logger.error({ err: error }, "[postgresScheduler] tick initial en echec"),
        );
        setInterval(() => {
          void runPostgresSchedulerTick().catch((error) =>
            logger.error({ err: error }, "[postgresScheduler] tick periodique en echec"),
          );
        }, 60_000);
      }
    } catch (error) {
      logger.error({ err: error }, "Discord bot initialization failed");
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction, store);
      } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await handleCodexComponent(interaction, store);
      }
    })().catch((error) => logger.error({ err: error }, "Discord interaction failed"));
  });

  client.on(Events.Error, (error) => logger.error({ err: error }, "Discord client error"));
  await client.login(token);
}
