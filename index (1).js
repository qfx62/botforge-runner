const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");

// ── Config from environment variables (set these in Railway) ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Track all running bot clients: botId → { client, commandMap }
const activeBots = new Map();

async function startBot(bot) {
  if (activeBots.has(bot.id)) {
    console.log(`Bot "${bot.name}" already running, skipping`);
    return;
  }

  if (!bot.bot_token) {
    console.log(`Bot "${bot.name}" has no token, skipping`);
    return;
  }

  console.log(`Starting bot "${bot.name}"...`);

  // Fetch commands
  const { data: commands } = await supabase
    .from("bot_commands")
    .select("*")
    .eq("bot_id", bot.id);

  const commandMap = {};
  const slashCommands = [];

  (commands || []).forEach((cmd) => {
    const name = cmd.trigger.replace(/^[!/]/, "").toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 32);
    const safeName = name || "cmd";
    commandMap[safeName] = cmd.response;
    slashCommands.push(
      new SlashCommandBuilder()
        .setName(safeName)
        .setDescription(cmd.command_name || cmd.response.slice(0, 100))
        .toJSON()
    );
  });

  // Register slash commands
  const rest = new REST({ version: "10" }).setToken(bot.bot_token);
  try {
    const me = await rest.get(Routes.user("@me"));
    if (slashCommands.length > 0) {
      await rest.put(Routes.applicationCommands(me.id), { body: slashCommands });
    }
    console.log(`  Registered ${slashCommands.length} commands for "${bot.name}" (${me.username})`);
  } catch (e) {
    console.error(`  Failed to register commands for "${bot.name}":`, e.message);
    await supabase.from("bots").update({ status: "error" }).eq("id", bot.id);
    return;
  }

  // Create Discord client
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on("ready", async () => {
    console.log(`  ✅ "${bot.name}" ONLINE as ${client.user.tag} — ${client.guilds.cache.size} servers`);
    await supabase.from("bots").update({ status: "online", servers_count: client.guilds.cache.size }).eq("id", bot.id);
    await supabase.from("bot_logs").insert({
      bot_id: bot.id, user_id: bot.user_id, level: "info",
      message: `Bot connected as ${client.user.tag} — ${client.guilds.cache.size} servers`,
    });
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const entry = activeBots.get(bot.id);
    const response = entry?.commandMap[interaction.commandName];
    if (response) {
      await interaction.reply(response);
      await supabase.from("bot_logs").insert({
        bot_id: bot.id, user_id: bot.user_id, level: "info",
        message: `/${interaction.commandName} by ${interaction.user.tag} in ${interaction.guild?.name || "DM"}`,
      });
    } else {
      await interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  });

  client.on("error", async (err) => {
    console.error(`  Bot "${bot.name}" error:`, err.message);
    await supabase.from("bots").update({ status: "error" }).eq("id", bot.id);
    await supabase.from("bot_logs").insert({
      bot_id: bot.id, user_id: bot.user_id, level: "error", message: err.message,
    });
  });

  try {
    await client.login(bot.bot_token);
    activeBots.set(bot.id, { client, commandMap });
  } catch (e) {
    console.error(`  Failed to login "${bot.name}":`, e.message);
    await supabase.from("bots").update({ status: "error" }).eq("id", bot.id);
  }
}

async function stopBot(botId) {
  const entry = activeBots.get(botId);
  if (!entry) return;
  console.log(`Stopping bot ${botId}...`);
  entry.client.destroy();
  activeBots.delete(botId);
  await supabase.from("bots").update({ status: "offline" }).eq("id", botId);
}

async function syncAll() {
  // Fetch ALL bots with tokens
  const { data: bots, error } = await supabase
    .from("bots")
    .select("*")
    .not("bot_token", "is", null);

  if (error) {
    console.error("Failed to fetch bots:", error.message);
    return;
  }

  const dbBotIds = new Set(bots.map((b) => b.id));

  // Start new bots
  for (const bot of bots) {
    if (!activeBots.has(bot.id)) {
      await startBot(bot);
    }
  }

  // Stop removed bots
  for (const [id] of activeBots) {
    if (!dbBotIds.has(id)) {
      await stopBot(id);
    }
  }

  // Refresh command maps for running bots
  for (const bot of bots) {
    const entry = activeBots.get(bot.id);
    if (!entry) continue;
    const { data: cmds } = await supabase.from("bot_commands").select("*").eq("bot_id", bot.id);
    if (cmds) {
      Object.keys(entry.commandMap).forEach((k) => delete entry.commandMap[k]);
      cmds.forEach((cmd) => {
        const name = cmd.trigger.replace(/^[!/]/, "").toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 32);
        entry.commandMap[name || "cmd"] = cmd.response;
      });
    }
    // Update server count
    if (entry.client.isReady()) {
      await supabase.from("bots").update({ servers_count: entry.client.guilds.cache.size }).eq("id", bot.id);
    }
  }
}

async function main() {
  console.log("🚀 BotForge Multi-Bot Runner starting...");
  await syncAll();

  // Sync every 60 seconds (picks up new bots, new commands, removed bots)
  setInterval(syncAll, 60_000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down all bots...");
    for (const [id] of activeBots) {
      await stopBot(id);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
