const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  PermissionFlagsBits,
  ChannelType,
  AttachmentBuilder,
} = require("discord.js");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));
const mongoose = require("mongoose");
require("dotenv").config();
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const MONGODB_URI = process.env.MONGODB_URI;

if (!TOKEN || !CLIENT_ID || !MONGODB_URI) {
  console.error("❌ Missing DISCORD_TOKEN, CLIENT_ID, or MONGODB_URI in .env");
  process.exit(1);
}

// ─── MongoDB Schema ───────────────────────────────────────────────────────────

const scheduleSchema = new mongoose.Schema({
  id:          { type: String, required: true, unique: true },
  channelId:   { type: String, required: true },
  title:       { type: String, required: true },
  sendAt:      { type: Number, required: true },
  mention:     { type: String, default: null },
  guildId:     { type: String, required: true },
  scheduledBy: { type: String, required: true },
  scheduledAt: { type: Number, required: true },
  message:     { type: String, default: "" },
  images:      { type: [String], default: [] },
  messageId:   { type: String, default: null },
  deleteAt:    { type: Number, default: null },
});

const Schedule = mongoose.model("Schedule", scheduleSchema);

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function loadSchedules() {
  try {
    return await Schedule.find({}).lean();
  } catch (err) {
    console.error("⚠️ Failed to load schedules from MongoDB:", err.message);
    throw err;
  }
}

async function saveSchedule(entry) {
  try {
    await Schedule.findOneAndUpdate({ id: entry.id }, entry, {
      upsert: true,
      new: true,
    });
  } catch (err) {
    console.error("❌ Failed to save schedule to MongoDB:", err.message);
  }
}

async function deleteSchedule(entryId) {
  try {
    await Schedule.deleteOne({ id: entryId });
  } catch (err) {
    console.error("❌ Failed to delete schedule from MongoDB:", err.message);
  }
}

async function updateSchedule(entryId, fields) {
  try {
    await Schedule.findOneAndUpdate({ id: entryId }, { $set: fields });
  } catch (err) {
    console.error("❌ Failed to update schedule in MongoDB:", err.message);
  }
}

// ─── Discord Client ───────────────────────────────────────────────────────────

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
        .setDescription(
          "When to post (e.g. 30m, 2h, June 17 10PM PHT, 2025-06-17 22:00 PHT)",
        )
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

// ─── Time Parsing ─────────────────────────────────────────────────────────────

function parseTime(input) {
  const trimmed = input.trim();

  const relative = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const hours = parseInt(relative[1] || 0);
    const minutes = parseInt(relative[2] || 0);
    const seconds = parseInt(relative[3] || 0);
    return Date.now() + hours * 3600000 + minutes * 60000 + seconds * 1000;
  }

  const tzOffsets = {
    PHT: "+08:00", PST: "+08:00", JST: "+09:00", KST: "+09:00",
    SGT: "+08:00", HKT: "+08:00", ICT: "+07:00", WIB: "+07:00",
    IST: "+05:30", PKT: "+05:00", GMT: "+00:00", UTC: "+00:00",
    EST: "-05:00", EDT: "-04:00", CDT: "-05:00", CST: "-06:00",
    MST: "-07:00", MDT: "-06:00", PDT: "-07:00",
  };

  let normalized = trimmed;
  let offsetStr = "+08:00"; // default: PHT

  const tzMatch = normalized.match(/\b([A-Z]{2,5})\s*$/);
  if (tzMatch && tzOffsets[tzMatch[1]]) {
    offsetStr = tzOffsets[tzMatch[1]];
    normalized = normalized.slice(0, normalized.lastIndexOf(tzMatch[1])).trim();
  }

  normalized = normalized.replace(/(\d)(AM|PM)/gi, "$1 $2");

  if (!/\b\d{4}\b/.test(normalized)) {
    normalized = `${normalized} ${new Date().getFullYear()}`;
  }

  const attempt = new Date(`${normalized} ${offsetStr}`);
  if (!isNaN(attempt.getTime())) return attempt.getTime();

  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) return fallback.getTime();

  return null;
}

function genId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ─── Timers ───────────────────────────────────────────────────────────────────

const activeTimers = new Map();
const deleteTimers = new Map();
const awaitingDM = new Map();

async function scheduleAnnouncement(entry) {
  const delay = entry.sendAt - Date.now();
  if (delay < 0) return;

  const sendTimer = setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      if (!channel) return;

      const textContent = `${entry.mention ? entry.mention + "\n" : ""}**${entry.title}**\n\n${entry.message}`;

      const files = [];
      if (entry.images && entry.images.length > 0) {
        for (const url of entry.images) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              const buffer = Buffer.from(await res.arrayBuffer());
              const filename = url.split("/").pop().split("?")[0] || "image.png";
              files.push(new AttachmentBuilder(buffer, { name: filename }));
            }
          } catch (fetchErr) {
            console.warn(`⚠️ Could not fetch image ${url}:`, fetchErr.message);
          }
        }
      }

      const msg = await channel.send({
        content: textContent,
        files,
        allowedMentions: { parse: ["roles", "users", "everyone"] },
      });

      const deleteDelay = 60 * 60 * 1000; // 1 hour
      await updateSchedule(entry.id, {
        messageId: msg.id,
        deleteAt: Date.now() + deleteDelay,
      });

      scheduleDelete(entry.id, msg.id, entry.channelId, deleteDelay);
    } catch (err) {
      console.error(`❌ Failed to send announcement ${entry.id}:`, err);
    }
  }, delay);

  activeTimers.set(entry.id, sendTimer);
}

function scheduleDelete(entryId, messageId, channelId, delay) {
  const t = setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(channelId);
      const msg = await channel.messages.fetch(messageId);
      await msg.delete();
    } catch {}

    await deleteSchedule(entryId);
    activeTimers.delete(entryId);
    deleteTimers.delete(entryId);
  }, delay);

  deleteTimers.set(entryId, t);
}

async function restoreSchedules() {
  let schedules;
  try {
    schedules = await loadSchedules();
  } catch {
    console.error("⚠️ Skipping schedule restore — DB could not be read.");
    return;
  }

  const now = Date.now();
  const toDelete = [];

  for (const entry of schedules) {
    if (!entry || !entry.id || !entry.channelId || !entry.sendAt) {
      console.warn("⚠️ Skipping malformed schedule entry:", entry);
      continue;
    }

    if (entry.messageId && entry.deleteAt) {
      if (entry.deleteAt > now) {
        scheduleDelete(entry.id, entry.messageId, entry.channelId, entry.deleteAt - now);
      } else {
        toDelete.push(entry.id);
      }
    } else if (entry.sendAt > now) {
      scheduleAnnouncement(entry);
    } else {
      console.warn(`⚠️ Missed announcement ${entry.id} — dropping.`);
      toDelete.push(entry.id);
    }
  }

  for (const id of toDelete) await deleteSchedule(id);

  console.log(`🔁 Restored ${schedules.length - toDelete.length} / ${schedules.length} announcement(s)`);
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`🤖 Bot ready: ${client.user.tag}`);
  restoreSchedules().catch((err) =>
    console.error("❌ Failed to restore schedules:", err),
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  // /announce
  if (interaction.isChatInputCommand() && interaction.commandName === "announce") {
    const channel = interaction.options.getChannel("channel");
    const timeInput = interaction.options.getString("time");
    const title = interaction.options.getString("title");
    const mention = interaction.options.getString("mention") ?? null;

    const testParse = parseTime(timeInput);
    if (!testParse) {
      return interaction.reply({
        content: "❌ Invalid time format. Try `30m`, `2h`, `June 17 10PM PHT`, or `2025-06-17 22:00 PHT`.",
        ephemeral: true,
      });
    }

    if (testParse <= Date.now()) {
      return interaction.reply({
        content: "❌ That time is already in the past! Please pick a future date/time.",
        ephemeral: true,
      });
    }

    await interaction.reply({ content: `📬 Check your DMs!`, ephemeral: true });

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
        `📎 You can also attach an image — just send it along with your message (or alone).\n` +
        `⚠️ Type \`cancel\` to cancel.`,
      );
    } catch (err) {
      awaitingDM.delete(interaction.user.id);
      await interaction.editReply({
        content: "❌ I couldn't DM you. Please enable DMs from server members and try again.",
      });
    }
  }

  // /announcements
  if (interaction.isChatInputCommand() && interaction.commandName === "announcements") {
    await interaction.deferReply({ ephemeral: true });

    let allSchedules;
    try {
      allSchedules = await loadSchedules();
    } catch {
      return interaction.editReply("❌ Failed to load announcements from database.");
    }

    const schedules = allSchedules.filter(
      (s) => s.guildId === interaction.guildId && s.sendAt > Date.now(),
    );

    if (schedules.length === 0) {
      return interaction.editReply("📭 No pending announcements.");
    }

    const list = schedules
      .map((s) => {
        const d = new Date(s.sendAt).toLocaleString("en-PH", {
          timeZone: "Asia/Manila",
          year: "numeric", month: "long", day: "numeric",
          hour: "2-digit", minute: "2-digit", hour12: true,
        });
        const preview = (s.message || "").substring(0, 80);
        const ellipsis = (s.message || "").length > 80 ? "..." : "";
        return (
          `**ID:** \`${s.id}\`\n` +
          `📌 <#${s.channelId}> • 🕐 \`${d} PHT\`\n` +
          `💬 ${preview}${ellipsis}`
        );
      })
      .join("\n\n");

    return interaction.editReply(`📋 **Pending Announcements:**\n\n${list}`);
  }

  // /cancelannounce
  if (interaction.isChatInputCommand() && interaction.commandName === "cancelannounce") {
    await interaction.deferReply({ ephemeral: true });

    const id = interaction.options.getString("id").toUpperCase();

    let schedules;
    try {
      schedules = await loadSchedules();
    } catch {
      return interaction.editReply("❌ Failed to load announcements from database.");
    }

    const entry = schedules.find((s) => s.id === id);
    if (!entry) {
      return interaction.editReply(`❌ No announcement found with ID \`${id}\`.`);
    }

    if (activeTimers.has(id)) { clearTimeout(activeTimers.get(id)); activeTimers.delete(id); }
    if (deleteTimers.has(id)) { clearTimeout(deleteTimers.get(id)); deleteTimers.delete(id); }

    await deleteSchedule(id);
    return interaction.editReply(`🗑️ Announcement \`${id}\` has been cancelled.`);
  }
});

// Listen for DMs
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.guild) return;

  const userId = message.author.id;

  if (!awaitingDM.has(userId)) {
    return message.reply("ℹ️ Use `/announce` in the server first to schedule an announcement.");
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
      "❌ The scheduled time has already passed. Please use `/announce` again with a future date/time.",
    );
  }

  const imageAttachments = [...message.attachments.values()]
    .filter((a) => a.contentType && a.contentType.startsWith("image/"))
    .map((a) => a.url);

  const entry = {
    id: genId(),
    channelId: pending.channelId,
    title: pending.title,
    sendAt,
    mention: pending.mention ?? null,
    guildId: pending.guildId,
    scheduledBy: pending.scheduledBy,
    scheduledAt: pending.scheduledAt,
    message: message.content,
    images: imageAttachments,
  };

  await saveSchedule(entry);
  scheduleAnnouncement(entry);

  const sendDate = new Date(entry.sendAt).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });

  const imageNote = entry.images.length > 0 ? `\n🖼️ Images attached: ${entry.images.length}` : "";

  return message.reply(
    `✅ Announcement **#${entry.id}** scheduled!\n` +
    `📌 Channel: <#${entry.channelId}>\n` +
    `🕐 Sends at: \`${sendDate} PHT\`\n` +
    `🗑️ Auto-deletes 1 hour after posting.${imageNote}`,
  );
});

// ─── HTTP Keep-Alive (for Railway health check) ───────────────────────────────

const http = require("http");
http
  .createServer((req, res) => { res.writeHead(200); res.end("Bot is alive!"); })
  .listen(process.env.PORT || 3000, () =>
    console.log(`🌐 HTTP server running on port ${process.env.PORT || 3000}`),
  );

// ─── Connect to MongoDB, then start bot ──────────────────────────────────────

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas");
    return client.login(TOKEN);
  })
  .then(() => {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    return rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  })
  .then(() => console.log("✅ Slash commands registered"))
  .catch((err) => {
    console.error("❌ Startup error:", err);
    process.exit(1);
  });