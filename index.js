const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const SCHEDULE_FILE = path.join(__dirname, "schedules.json");

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Missing DISCORD_TOKEN or CLIENT_ID in .env");
  process.exit(1);
}

function loadSchedules() {
  if (!fs.existsSync(SCHEDULE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveSchedules(schedules) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages, 
    GatewayIntentBits.MessageContent, 
  ],
  partials: ["CHANNEL"], 
});

const commands = [
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Schedule an announcement")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to post in")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("time")
        .setDescription("When to post it (e.g. 30m, 2h, 10s,)")
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("title")
        .setDescription("Custom title (e.g. Raid Announcement)")
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("mention")
        .setDescription("Who to mention (e.g. @Role, @User, @everyone, @here)")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("announcements")
    .setDescription("List all pending announcements")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("cancelannounce")
    .setDescription("Cancel a scheduled announcement by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((opt) =>
      opt.setName("id").setDescription("Announcement ID").setRequired(true),
    ),
].map((cmd) => cmd.toJSON());

function parseTime(input) {
  const relative = input.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const hours = parseInt(relative[1] || 0);
    const minutes = parseInt(relative[2] || 0);
    const seconds = parseInt(relative[3] || 0);
    return (
      Date.now() + hours * 60 * 60 * 1000 + minutes * 60 * 1000 + seconds * 1000
    );
  }
  const absolute = new Date(input + " UTC+8");
  if (!isNaN(absolute.getTime())) return absolute.getTime();
  return null;
}

function genId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const activeTimers = new Map();
const awaitingDM = new Map();

async function scheduleAnnouncement(entry) {
  const delay = entry.sendAt - Date.now();
  if (delay < 0) return;

  const sendTimer = setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      if (!channel) return;

      const msg = await channel.send({
        content: `${entry.mention ? entry.mention + "\n" : ""}**${entry.title}**\n\n${entry.message}`,
        allowedMentions: { parse: ["roles", "users", "everyone"] },
      });

      setTimeout(
        async () => {
          try {
            await msg.delete();
          } catch {}
          const schedules = loadSchedules().filter((s) => s.id !== entry.id);
          saveSchedules(schedules);
          activeTimers.delete(entry.id);
        },
        60 * 60 * 1000,
      );
    } catch (err) {
      console.error(`❌ Failed to send announcement ${entry.id}:`, err);
    }
  }, delay);

  activeTimers.set(entry.id, sendTimer);
}

function restoreSchedules() {
  const schedules = loadSchedules();
  const now = Date.now();
  const valid = schedules.filter((s) => s.sendAt > now);
  if (valid.length !== schedules.length) saveSchedules(valid);
  for (const entry of valid) scheduleAnnouncement(entry);
  if (valid.length > 0)
    console.log(`🔁 Restored ${valid.length} pending announcement(s)`);
}

client.once(Events.ClientReady, () => {
  console.log(`🤖 Bot ready: ${client.user.tag}`);
  restoreSchedules();
});

client.on(Events.InteractionCreate, async (interaction) => {
  //announce
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "announce"
  ) {
    const channel = interaction.options.getChannel("channel");
    const timeInput = interaction.options.getString("time");
    const title = interaction.options.getString("title");
    const mention = interaction.options.getString("mention") ?? null;

    const testParse = parseTime(timeInput);
    if (!testParse) {
      return interaction.reply({
        content:
          "❌ Invalid time format. Use `30m`, `2h`, `10s`, or `YYYY-MM-DD HH:mm`.",
        ephemeral: true,
      });
    }

    awaitingDM.set(interaction.user.id, {
      channelId: channel.id,
      title,
      timeInput,
      mention,
      guildId: interaction.guildId,
      scheduledBy: interaction.user.id,
      scheduledAt: Date.now(),
    });

    try {
      const user = await client.users.fetch(interaction.user.id);
      await user.send(
        `📝 **Please send me your announcement message now!**\n\n` +
          `> Title: **${title}**\n` +
          `> Channel: <#${channel.id}>\n\n` +
          `⚠️ Type \`cancel\` to cancel.`,
      );
      return interaction.reply({
        content: `📬 Check your DMs!`,
        ephemeral: true,
      });
    } catch (err) {
      awaitingDM.delete(interaction.user.id);
      return interaction.reply({
        content:
          "❌ I couldn't DM you. Please enable DMs from server members and try again.",
        ephemeral: true,
      });
    }
  }

  // announcements
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "announcements"
  ) {
    await interaction.deferReply({ ephemeral: true });

    const schedules = loadSchedules().filter(
      (s) => s.guildId === interaction.guildId && s.sendAt > Date.now(),
    );

    if (schedules.length === 0) {
      return interaction.editReply("📭 No pending announcements.");
    }

    const list = schedules
      .map((s) => {
        const d = new Date(s.sendAt).toLocaleString("en-PH", {
          timeZone: "Asia/Manila",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
        return (
          `**ID:** \`${s.id}\`\n` +
          `📌 <#${s.channelId}> • 🕐 \`${d} PHT\`\n` +
          `💬 ${s.message.substring(0, 80)}${s.message.length > 80 ? "..." : ""}`
        );
      })
      .join("\n\n");

    return interaction.editReply(`📋 **Pending Announcements:**\n\n${list}`);
  }

  // cancel announce
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "cancelannounce"
  ) {
    await interaction.deferReply({ ephemeral: true });

    const id = interaction.options.getString("id").toUpperCase();
    const schedules = loadSchedules();
    const entry = schedules.find((s) => s.id === id);

    if (!entry) {
      return interaction.editReply(
        `❌ No announcement found with ID \`${id}\`.`,
      );
    }

    if (activeTimers.has(id)) {
      clearTimeout(activeTimers.get(id));
      activeTimers.delete(id);
    }

    saveSchedules(schedules.filter((s) => s.id !== id));
    return interaction.editReply(
      `🗑️ Announcement \`${id}\` has been cancelled.`,
    );
  }
});

// Listen for DM
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.guild) return;

  const userId = message.author.id;

  if (!awaitingDM.has(userId)) {
    return message.reply(
      "ℹ️ Use `/announce` in the server first to schedule an announcement.",
    );
  }

  if (message.content.trim().toLowerCase() === "cancel") {
    awaitingDM.delete(userId);
    return message.reply("❌ Announcement cancelled.");
  }

  const pending = awaitingDM.get(userId);
  awaitingDM.delete(userId);

  const sendAt = parseTime(pending.timeInput);

  if (!sendAt || sendAt <= Date.now()) {
    return message.reply(
      "❌ The scheduled time has already passed. Please use `/announce` again with a longer delay.",
    );
  }

  const entry = {
    id: genId(),
    channelId: pending.channelId,
    title: pending.title,
    sendAt, // ← fresh timestamp
    mention: pending.mention ?? null,
    guildId: pending.guildId,
    scheduledBy: pending.scheduledBy,
    scheduledAt: pending.scheduledAt,
    message: message.content,
  };

  const schedules = loadSchedules();
  schedules.push(entry);
  saveSchedules(schedules);
  scheduleAnnouncement(entry);

  const sendDate = new Date(entry.sendAt).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  return message.reply(
    `✅ Announcement **#${entry.id}** scheduled!\n` +
      `📌 Channel: <#${entry.channelId}>\n` +
      `🕐 Sends at: \`${sendDate} PHT\`\n` +
      `🗑️ Auto-deletes 1 hour after posting.`,
  );
});

client.login(TOKEN).then(() => {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  rest
    .put(Routes.applicationCommands(CLIENT_ID), { body: commands })
    .then(() => console.log("✅ Slash commands registered"))
    .catch((err) => console.error("❌ Command registration failed:", err));
});
