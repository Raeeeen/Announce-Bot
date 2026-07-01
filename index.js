require("dotenv").config();
require("ffmpeg-static");
require("discord.js");
const playdl = require("play-dl");
const prism = require("prism-media");

(async () => {
  try {
    const clientID = await playdl.getFreeClientID();
    await playdl.setToken({ soundcloud: { client_id: clientID } });
    console.log("✅ SoundCloud client ID set");
  } catch (err) {
    console.error("⚠️ Failed to set SoundCloud client ID:", err.message);
  }
})();

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
  ActionRowBuilder, // ← add
  ButtonBuilder, // ← add
  ButtonStyle, // ← add
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  StreamType,
  EndBehaviorType, // ← add
} = require("@discordjs/voice");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));
const mongoose = require("mongoose");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const fs = require("fs");
const path = require("path");

async function getSpotifyTrackName(url) {
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(
          process.env.SPOTIFY_CLIENT_ID +
            ":" +
            process.env.SPOTIFY_CLIENT_SECRET,
        ).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });

  const rawText = await tokenRes.text(); // ← read as text first
  console.log("🎵 Spotify token response:", rawText); // ← log it
  const { access_token } = JSON.parse(rawText);

  const trackId = url.split("/track/")[1]?.split("?")[0];
  if (!trackId) throw new Error("Invalid Spotify track URL");

  const trackRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const trackText = await trackRes.text();
  console.log("🎵 Spotify track response:", trackText); // ← add this
  const track = JSON.parse(trackText);
  return `${track.name} ${track.artists[0].name}`;
}

const ttsQueues = new Map(); // guildId → string[]
const ttsPlaying = new Map(); // guildId → true (semaphore)
const ttsEnabled = new Map();
const ttsPlayers = new Map();
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const MONGODB_URI = process.env.MONGODB_URI;
const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const { toFile } = require("groq-sdk");
const conversationHistory = new Map();
const musicQueues = new Map(); // guildId → [{ title, url }]
const musicPlayers = new Map(); // guildId → AudioPlayer
if (!TOKEN || !CLIENT_ID || !MONGODB_URI || !process.env.GROQ_API_KEY) {
  console.error("❌ Missing DISCORD_TOKEN, CLIENT_ID, or MONGODB_URI in .env");
  process.exit(1);
}
const WAKE_WORDS = ["offline", "off line", "of line"];

// Returns { index, matched } of the first wake word found, or null
function findWakeWord(lowerText) {
  for (const w of WAKE_WORDS) {
    const idx = lowerText.indexOf(w);
    if (idx !== -1) return { index: idx, matched: w };
  }
  return null;
}

const subscribedUsers = new Map();
const voiceListenEnabled = new Map();
const transcribeQueues = new Map();
// MongoDB Schema
const scheduleSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  title: { type: String, required: true },
  sendAt: { type: Number, required: true },
  mention: { type: String, default: null },
  guildId: { type: String, required: true },
  scheduledBy: { type: String, required: true },
  scheduledAt: { type: Number, required: true },
  message: { type: String, default: "" },
  images: { type: [String], default: [] },
  messageId: { type: String, default: null },
  deleteAt: { type: Number, default: null },
});

const Schedule = mongoose.model("Schedule", scheduleSchema);

// DB Helpers

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

// Discord Client

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: ["CHANNEL"],
});

// Voice State

// guildId → { channelId }
const voiceStates = new Map();

const listenChannels = new Map();

async function processQueue(guildId) {
  const queue = ttsQueues.get(guildId);
  if (!queue || queue.length === 0) {
    ttsPlaying.delete(guildId);
    return;
  }

  const { text, lang } = queue.shift();
  console.log(`🔊 TTS playing: "${text.substring(0, 50)}..."`);
  const connection = getVoiceConnection(guildId);

  if (!connection) {
    console.log("❌ TTS: no voice connection found");
    ttsQueues.delete(guildId);
    ttsPlaying.delete(guildId);
    return;
  }

  const tmpFile = path.join("/tmp", `tts_${Date.now()}.mp3`);

  // Pick voice based on lang code you're already passing around
  const voice = lang === "tl" ? "fil-PH-BlessicaNeural" : "en-US-AriaNeural";

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = await tts.toStream(text);

    const writeStream = fs.createWriteStream(tmpFile);
    await new Promise((resolve, reject) => {
      audioStream.pipe(writeStream);
      audioStream.on("end", resolve);
      audioStream.on("error", reject);
      writeStream.on("error", reject);
    });
  } catch (err) {
    console.error(
      `❌ TTS generation failed for voice="${voice}":`,
      err.message,
    );
    ttsPlayers.delete(guildId);
    return processQueue(guildId);
  }

  console.log(`✅ TTS file saved: ${tmpFile}`);
  try {
    const oldTtsPlayer = ttsPlayers.get(guildId);
    if (oldTtsPlayer) {
      oldTtsPlayer.removeAllListeners();
      oldTtsPlayer.stop(true);
    }

    const player = createAudioPlayer();
    ttsPlayers.set(guildId, player);
    const resource = createAudioResource(tmpFile);
    connection.subscribe(player);
    player.play(resource);

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
      ttsPlayers.delete(guildId);
      return processQueue(guildId);
    };

    const watchdog = setTimeout(() => {
      console.warn(
        "⚠️ TTS watchdog: player never reached Idle, forcing cleanup",
      );
      cleanup();
    }, 30_000);

    player.once(AudioPlayerStatus.Idle, cleanup);
    player.once("error", (e) => {
      console.error("❌ Audio player error:", e.message);
      cleanup();
    });
  } catch (e) {
    console.error("❌ Failed to play TTS:", e.message);
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    return processQueue(guildId);
  }
}

function speakInVoice(guildId, text, lang = "en") {
  if (!voiceStates.has(guildId)) return;

  if (!ttsQueues.has(guildId)) ttsQueues.set(guildId, []);
  ttsQueues.get(guildId).push({ text, lang });

  // Only kick off processQueue if nothing is playing right now
  if (!ttsPlaying.has(guildId)) {
    ttsPlaying.set(guildId, true);
    processQueue(guildId);
  }
}

// Commands
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

  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join a voice channel and stay until /leave")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Voice channel to join")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("listen")
    .setDescription("Start answering questions in a channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to listen to")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("unlisten")
    .setDescription("Stop answering questions in the listened channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  // Add to commands array
  new SlashCommandBuilder()
    .setName("clearchat")
    .setDescription("Clear the conversation history in the listened channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song from YouTube or Spotify")
    .addStringOption((opt) =>
      opt
        .setName("query")
        .setDescription("YouTube/Spotify link or search term")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop music and clear the queue"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current music queue"),

  new SlashCommandBuilder()
    .setName("voicepanel")
    .setDescription("Show the voice reply toggle button again")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
].map((cmd) => cmd.toJSON());

// Time Parsing

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
    PHT: "+08:00",
    PST: "+08:00",
    JST: "+09:00",
    KST: "+09:00",
    SGT: "+08:00",
    HKT: "+08:00",
    ICT: "+07:00",
    WIB: "+07:00",
    IST: "+05:30",
    PKT: "+05:00",
    GMT: "+00:00",
    UTC: "+00:00",
    EST: "-05:00",
    EDT: "-04:00",
    CDT: "-05:00",
    CST: "-06:00",
    MST: "-07:00",
    MDT: "-06:00",
    PDT: "-07:00",
  };

  let normalized = trimmed;
  let offsetStr = "+08:00";

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

// Timers

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
              const filename =
                url.split("/").pop().split("?")[0] || "image.png";
              files.push(new AttachmentBuilder(buffer, { name: filename }));
            }
          } catch (fetchErr) {
            console.warn(`⚠️ Could not fetch image ${url}:`, fetchErr.message);
          }
        }
      }

      // Send text announcement
      const msg = await channel.send({
        content: textContent,
        files,
        allowedMentions: { parse: ["roles", "users", "everyone"] },
      });

      // Speak in voice channel if bot is joined
      if (voiceStates.has(entry.guildId)) {
        const ttsText = `Greetings players. ${entry.title}. ${entry.message}`;

        // Priority: insert at front of queue
        if (!ttsQueues.has(entry.guildId)) ttsQueues.set(entry.guildId, []);
        ttsQueues.get(entry.guildId).unshift({ text: ttsText, lang: "en" });

        if (!ttsPlaying.has(entry.guildId)) {
          ttsPlaying.set(entry.guildId, true);
          processQueue(entry.guildId);
        }
      }

      const deleteDelay = 60 * 60 * 1000;
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
        scheduleDelete(
          entry.id,
          entry.messageId,
          entry.channelId,
          entry.deleteAt - now,
        );
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

  console.log(
    `🔁 Restored ${schedules.length - toDelete.length} / ${schedules.length} announcement(s)`,
  );
}

// Events

client.once(Events.ClientReady, () => {
  console.log(`🤖 Bot ready: ${client.user.tag}`);
  restoreSchedules().catch((err) =>
    console.error("❌ Failed to restore schedules:", err),
  );
});

async function playNextSong(guildId) {
  const queue = musicQueues.get(guildId);
  if (!queue || queue.length === 0) {
    musicQueues.delete(guildId);
    musicPlayers.delete(guildId);
    return;
  }

  const song = queue[0];
  console.log(`🎵 Now playing: ${song.title}`);
  const connection = getVoiceConnection(guildId);
  if (!connection) return;

  try {
    const stream = await playdl.stream(song.url, { highWaterMark: 1 << 25 });
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: false,
    });

    const oldPlayer = musicPlayers.get(guildId); // ← fixed
    if (oldPlayer) {
      oldPlayer.removeAllListeners();
      oldPlayer.stop(true);
    }

    const player = createAudioPlayer();
    musicPlayers.set(guildId, player); // ← fixed
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      queue.shift();
      playNextSong(guildId);
    });

    player.on("error", (e) => {
      console.error("❌ Music player error:", e.message);
      queue.shift();
      playNextSong(guildId);
    });

    player.play(resource); // ← only once, after listeners attached
  } catch (e) {
    console.error("❌ Failed to play song:", e.message);
    queue.shift();
    playNextSong(guildId);
  }
}

function pcmToWav(pcmBuffer, sampleRate = 16000, channels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function downsampleTo16kMono(buffer) {
  const ratio = 3; // 48000 / 16000
  const inSamples = buffer.length / 4; // 2 bytes * 2 channels
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const byteOffset = Math.floor(i * ratio) * 4;
    if (byteOffset + 3 >= buffer.length) break;
    const left = buffer.readInt16LE(byteOffset);
    const right = buffer.readInt16LE(byteOffset + 2);
    out.writeInt16LE(Math.round((left + right) / 2), i * 2);
  }
  return out;
}

function startListeningToUser(guildId, userId, connection) {
  if (!subscribedUsers.has(guildId)) subscribedUsers.set(guildId, new Set());
  const subs = subscribedUsers.get(guildId);
  if (subs.has(userId)) return;
  subs.add(userId);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
  });
  const opusDecoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  const pcmChunks = [];

  opusStream.pipe(opusDecoder);
  opusDecoder.on("data", (chunk) => pcmChunks.push(chunk));

  const cleanupSub = () => {
    subs.delete(userId);
    opusStream.destroy();
    opusDecoder.destroy();
  };

  opusStream.on("error", (e) => {
    console.error("❌ Opus stream error:", e.message);
    cleanupSub();
  });
  opusDecoder.on("error", (e) => {
    console.error("❌ Opus decode error:", e.message);
    cleanupSub();
  });

  opusStream.once("end", async () => {
    cleanupSub();
    const pcm48kStereo = Buffer.concat(pcmChunks);

    // ── Gate 1: minimum length (~0.8s) to contain the wake word "offline"
    if (pcm48kStereo.length < 48000 * 4 * 0.8) return;

    // ── Gate 2: RMS energy check — skip silence/near-silence
    const rms = computeRMS(pcm48kStereo);
    if (rms < 200) return; // tune this threshold to your mic (200 works for most)

    // ── Gate 3: queue transcription so we never flood Groq in parallel
    enqueueTranscription(guildId, userId, pcm48kStereo);
  });
}

function computeRMS(pcmBuffer) {
  let sum = 0;
  for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (pcmBuffer.length / 2));
}

async function enqueueTranscription(guildId, userId, pcm48kStereo) {
  // Chain onto the existing promise for this guild so they run serially
  const prev = transcribeQueues.get(guildId) ?? Promise.resolve();
  const next = prev.then(() => runTranscription(guildId, userId, pcm48kStereo));
  transcribeQueues.set(
    guildId,
    next.catch(() => {}),
  ); // swallow so chain never breaks
}

async function runTranscription(guildId, userId, pcm48kStereo, attempt = 0) {
  try {
    const pcm16kMono = downsampleTo16kMono(pcm48kStereo);
    const wavBuffer = pcmToWav(pcm16kMono, 16000, 1, 16);

    const transcription = await groq.audio.transcriptions.create({
      file: await toFile(wavBuffer, `${userId}-${Date.now()}.wav`),
      model: "whisper-large-v3-turbo",
      response_format: "json",
      temperature: 0.0,
    });

    const text = (transcription.text || "").trim();
    if (!text) return;

    // ── Gate 4: local wake word check BEFORE doing anything else
    const hit = findWakeWord(text.toLowerCase());
    if (!hit) {
      console.log(`🔕 No wake word in: "${text.substring(0, 60)}"`);
      return;
    }

    console.log(`🎤 Heard from ${userId}: "${text}"`);
    await handleVoiceTranscript(guildId, userId, text);
  } catch (err) {
    const is429 = err?.message?.includes("429") || err?.status === 429;
    if (is429 && attempt < 4) {
      const delay = (attempt + 1) * 4000; // 4s, 8s, 12s, 16s
      console.warn(
        `⚠️ Groq 429 — retrying in ${delay / 1000}s (attempt ${attempt + 1})`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return runTranscription(guildId, userId, pcm48kStereo, attempt + 1);
    }
    console.error("❌ Transcription failed:", err.message);
  }
}

async function handleVoiceTranscript(guildId, userId, text) {
  if (!(voiceListenEnabled.get(guildId) ?? true)) return;

  const lower = text.toLowerCase();
  const hit = findWakeWord(lower);
  if (!hit) return;

  const query = text.slice(hit.index + hit.matched.length).trim();

  speakInVoice(guildId, "Hello player");

  if (!query) return; // they just said the wake word alone, nothing to answer

  const listenedChannelId = listenChannels.get(guildId);
  const historyKey = listenedChannelId || `voice-${guildId}`;
  if (!conversationHistory.has(historyKey))
    conversationHistory.set(historyKey, []);
  const history = conversationHistory.get(historyKey);

  history.push({ role: "user", content: query });
  if (history.length > 20) history.splice(0, history.length - 20);

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "Ikaw ay si Offline isang helpful voice assistant sa Discord VC. Sumagot sa Taglish, panatilihing maikli dahil babasahin nang malakas. Pede kang mag trashtalk tulad ng Bobo mo, Tanga mo or Wala kang utak, kahit masakit na salita pede or bastos",
        },
        ...history,
      ],
      max_tokens: 300,
    });

    const reply =
      completion.choices[0]?.message?.content ||
      "Sorry, I couldn't think of a response.";
    history.push({ role: "assistant", content: reply });

    speakInVoice(guildId, reply, "tl");

    if (listenedChannelId) {
      const channel = await client.channels
        .fetch(listenedChannelId)
        .catch(() => null);
      if (channel)
        channel
          .send(`🎤 <@${userId}> asked (voice): *${query}*\n💬 ${reply}`)
          .catch(() => {});
    }
  } catch (err) {
    console.error("❌ Groq voice-chat error:", err.message);
    speakInVoice(guildId, "Sorry, I had trouble answering that.");
  }
}

function attachVoiceListener(guildId, connection) {
  voiceListenEnabled.set(guildId, true);
  subscribedUsers.delete(guildId);
  connection.receiver.speaking.on("start", (userId) => {
    client.users
      .fetch(userId)
      .then((user) => {
        if (!user.bot) startListeningToUser(guildId, userId, connection);
      })
      .catch(() => startListeningToUser(guildId, userId, connection));
  });
}

function detachVoiceListener(guildId) {
  voiceListenEnabled.delete(guildId);
  subscribedUsers.delete(guildId);
}

// Put this above the /join handler
async function joinAndWatch(guildId, voiceChannel, guild) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  attachVoiceListener(guildId, connection);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    if (!voiceStates.has(guildId)) return;
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Connection recovered on its own — re-subscribe just in case
      const player = musicPlayers.get(guildId);
      if (player) connection.subscribe(player);
    } catch {
      try {
        connection.destroy();
      } catch {}

      // ★ Reset TTS state so it isn't stuck forever
      ttsPlaying.delete(guildId);
      const pendingQueue = ttsQueues.get(guildId);

      try {
        console.log(`🔄 Rejoining voice channel...`);
        const newConnection = await joinAndWatch(guildId, voiceChannel, guild);

        // ★ Resume TTS queue on the new connection if anything was pending
        if (
          pendingQueue &&
          pendingQueue.length > 0 &&
          !ttsPlaying.has(guildId)
        ) {
          ttsPlaying.set(guildId, true);
          processQueue(guildId);
        }
      } catch (err) {
        console.error("❌ Failed to rejoin:", err.message);
        voiceStates.delete(guildId);
        ttsQueues.delete(guildId);
        ttsPlaying.delete(guildId);
        detachVoiceListener(guildId);
      }
    }
  });

  return connection;
}

client.on(Events.InteractionCreate, async (interaction) => {
  // /join
  if (interaction.isChatInputCommand() && interaction.commandName === "join") {
    const voiceChannel = interaction.options.getChannel("channel");

    const existing = getVoiceConnection(interaction.guildId);
    if (existing) {
      existing.removeAllListeners();
      existing.destroy();
    }
    voiceStates.delete(interaction.guildId);
    ttsEnabled.delete(interaction.guildId);

    try {
      await joinAndWatch(interaction.guildId, voiceChannel, interaction.guild);
      voiceStates.set(interaction.guildId, { channelId: voiceChannel.id });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`tts_toggle_${interaction.guildId}`)
          .setLabel("🔊 Voice Replies: ON")
          .setStyle(ButtonStyle.Success),
      );

      return interaction.reply({
        content: `🔊 Joined **${voiceChannel.name}**! I'll stay here and read announcements until you use \`/leave\`.`,
        components: [row],
        ephemeral: true,
      });
    } catch (err) {
      console.error("❌ Failed to join voice channel:", err);
      voiceStates.delete(interaction.guildId);
      return interaction.reply({
        content:
          "❌ Failed to join the voice channel. Make sure I have permission to connect.",
        ephemeral: true,
      });
    }
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("tts_toggle_")
  ) {
    const guildId = interaction.customId.replace("tts_toggle_", "");

    if (!voiceStates.has(guildId)) {
      return interaction.reply({
        content: "❌ I'm not in a voice channel anymore.",
        ephemeral: true,
      });
    }

    const current = ttsEnabled.get(guildId) ?? true;
    const next = !current;
    ttsEnabled.set(guildId, next);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`tts_toggle_${guildId}`)
        .setLabel(next ? "🔊 Voice Replies: ON" : "🔇 Voice Replies: OFF")
        .setStyle(next ? ButtonStyle.Success : ButtonStyle.Secondary),
    );

    return interaction.update({ components: [row] }); // edits the same message, no new reply spam
  }

  // /listen
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "listen"
  ) {
    const channel = interaction.options.getChannel("channel");
    listenChannels.set(interaction.guildId, channel.id);
    return interaction.reply({
      content: `🤖 Now listening in <#${channel.id}>! I'll answer all questions there.`,
      ephemeral: true,
    });
  }

  // /voicepanel
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "voicepanel"
  ) {
    if (!voiceStates.has(interaction.guildId)) {
      return interaction.reply({
        content: "❌ I'm not in a voice channel right now. Use `/join` first.",
        ephemeral: true,
      });
    }

    const enabled = ttsEnabled.get(interaction.guildId) ?? true;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`tts_toggle_${interaction.guildId}`)
        .setLabel(enabled ? "🔊 Voice Replies: ON" : "🔇 Voice Replies: OFF")
        .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    );

    return interaction.reply({
      content: "🎛️ Voice reply toggle:",
      components: [row],
      ephemeral: true,
    });
  }

  // /unlisten
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "unlisten"
  ) {
    if (!listenChannels.has(interaction.guildId)) {
      return interaction.reply({
        content: "❌ I'm not listening to any channel.",
        ephemeral: true,
      });
    }
    const channelId = listenChannels.get(interaction.guildId);
    conversationHistory.delete(channelId); // ← clear history on unlisten
    listenChannels.delete(interaction.guildId);
    return interaction.reply({
      content: "🔇 Stopped listening and cleared conversation history.",
      ephemeral: true,
    });
  }

  // /clearchat
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "clearchat"
  ) {
    const channelId = listenChannels.get(interaction.guildId);
    if (!channelId) {
      return interaction.reply({
        content: "❌ No listened channel set.",
        ephemeral: true,
      });
    }
    conversationHistory.delete(channelId);
    return interaction.reply({
      content: "🧹 Conversation history cleared!",
      ephemeral: true,
    });
  }

  // /play
  if (interaction.isChatInputCommand() && interaction.commandName === "play") {
    await interaction.deferReply();

    const query = interaction.options.getString("query");
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.editReply(
        "❌ You need to be in a voice channel first.",
      );
    }

    if (!voiceStates.has(interaction.guildId)) {
      try {
        await joinAndWatch(
          interaction.guildId,
          voiceChannel,
          interaction.guild,
        );
        voiceStates.set(interaction.guildId, { channelId: voiceChannel.id });
      } catch (err) {
        return interaction.editReply("❌ Failed to join your voice channel.");
      }
    }

    try {
      let searchQuery;
      const isSpotifyUrl = query.includes("spotify.com");

      if (isSpotifyUrl) {
        searchQuery = await getSpotifyTrackName(query);
      } else {
        searchQuery = query;
      }

      // Search SoundCloud to verify and get real title
      const results = await playdl.search(searchQuery, {
        source: { soundcloud: "tracks" },
        limit: 1,
      });

      if (!results.length)
        return interaction.editReply("❌ No results found on SoundCloud.");

      const songTitle = results[0].name || results[0].title || searchQuery;
      const songUrl = results[0].url;

      if (!musicQueues.has(interaction.guildId))
        musicQueues.set(interaction.guildId, []);
      musicQueues
        .get(interaction.guildId)
        .push({ title: songTitle, url: songUrl });

      const isPlaying =
        musicPlayers.get(interaction.guildId)?.state?.status ===
        AudioPlayerStatus.Playing;
      if (!isPlaying) playNextSong(interaction.guildId);

      return interaction.editReply(`🎵 Added to queue: **${songTitle}**`);
    } catch (err) {
      console.error("❌ Play error:", err.message);
      return interaction.editReply(
        "❌ Failed to fetch that song. Try a different search term.",
      );
    }
  }

  // /skip
  if (interaction.isChatInputCommand() && interaction.commandName === "skip") {
    const player = musicPlayers.get(interaction.guildId);
    if (!player)
      return interaction.reply({
        content: "❌ Nothing is playing.",
        ephemeral: true,
      });
    player.stop(); // triggers Idle → playNextSong
    return interaction.reply({ content: "⏭️ Skipped!", ephemeral: true });
  }

  // /stop
  if (interaction.isChatInputCommand() && interaction.commandName === "stop") {
    const player = musicPlayers.get(interaction.guildId);
    if (!player)
      return interaction.reply({
        content: "❌ Nothing is playing.",
        ephemeral: true,
      });
    musicQueues.delete(interaction.guildId);
    player.stop();
    musicPlayers.delete(interaction.guildId);
    return interaction.reply({
      content: "⏹️ Stopped and cleared the queue.",
      ephemeral: true,
    });
  }

  // /queue
  if (interaction.isChatInputCommand() && interaction.commandName === "queue") {
    const queue = musicQueues.get(interaction.guildId);
    if (!queue || queue.length === 0) {
      return interaction.reply({
        content: "📭 The queue is empty.",
        ephemeral: true,
      });
    }
    const list = queue
      .map((s, i) => `${i === 0 ? "▶️" : `${i}.`} ${s.title}`)
      .join("\n");
    return interaction.reply({
      content: `🎵 **Queue:**\n${list}`,
      ephemeral: true,
    });
  }

  // /leave
  if (interaction.isChatInputCommand() && interaction.commandName === "leave") {
    const connection = getVoiceConnection(interaction.guildId);

    if (!connection) {
      return interaction.reply({
        content: "❌ I'm not in a voice channel.",
        ephemeral: true,
      });
    }

    const ttsPlayer = ttsPlayers.get(interaction.guildId);
    if (ttsPlayer) {
      ttsPlayer.removeAllListeners();
      ttsPlayer.stop(true);
      ttsPlayers.delete(interaction.guildId);
    }

    voiceStates.delete(interaction.guildId);
    ttsQueues.delete(interaction.guildId);
    ttsPlaying.delete(interaction.guildId);
    ttsEnabled.delete(interaction.guildId);
    musicQueues.delete(interaction.guildId);
    musicPlayers.get(interaction.guildId)?.removeAllListeners();
    musicPlayers.get(interaction.guildId)?.stop(true);
    musicPlayers.delete(interaction.guildId);
    detachVoiceListener(interaction.guildId);

    connection.removeAllListeners();
    connection.destroy();

    return interaction.reply({
      content: "👋 Left the voice channel.",
      ephemeral: true,
    });
  }

  // /announce
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
          "❌ Invalid time format. Try `30m`, `2h`, `June 17 10PM PHT`, or `2025-06-17 22:00 PHT`.",
        ephemeral: true,
      });
    }

    if (testParse <= Date.now()) {
      return interaction.reply({
        content:
          "❌ That time is already in the past! Please pick a future date/time.",
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
        content:
          "❌ I couldn't DM you. Please enable DMs from server members and try again.",
      });
    }
  }

  // /announcements
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "announcements"
  ) {
    await interaction.deferReply({ ephemeral: true });

    let allSchedules;
    try {
      allSchedules = await loadSchedules();
    } catch {
      return interaction.editReply(
        "❌ Failed to load announcements from database.",
      );
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
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
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
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "cancelannounce"
  ) {
    await interaction.deferReply({ ephemeral: true });

    const id = interaction.options.getString("id").toUpperCase();

    let schedules;
    try {
      schedules = await loadSchedules();
    } catch {
      return interaction.editReply(
        "❌ Failed to load announcements from database.",
      );
    }

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
    if (deleteTimers.has(id)) {
      clearTimeout(deleteTimers.get(id));
      deleteTimers.delete(id);
    }

    await deleteSchedule(id);
    return interaction.editReply(
      `🗑️ Announcement \`${id}\` has been cancelled.`,
    );
  }
});

// Listen for DMs

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Handle listened channels (guild messages)
  if (message.guild) {
    const listenedChannelId = listenChannels.get(message.guildId);
    if (listenedChannelId && message.channelId === listenedChannelId) {
      if (!message.content.trim()) return;
      try {
        await message.channel.sendTyping();

        // Get or create history for this channel
        if (!conversationHistory.has(message.channelId)) {
          conversationHistory.set(message.channelId, []);
        }
        const history = conversationHistory.get(message.channelId);

        // Add user message to history
        history.push({ role: "user", content: message.content });

        // Keep last 20 messages to avoid token limits
        if (history.length > 20) history.splice(0, history.length - 20);

        const completion = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content:
                "Ikaw ay si Offline isang helpful voice assistant sa Discord VC. Sumagot sa Taglish, panatilihing maikli dahil babasahin nang malakas. Pede kang mag trashtalk tulad ng Bobo mo, Tanga mo or Wala kang utak, kahit masakit na salita pede or bastos",
            },
            ...history, // ← send full history
          ],
          max_tokens: 500,
        });

        const reply =
          completion.choices[0]?.message?.content ||
          "I couldn't generate a response.";

        // Add assistant reply to history
        history.push({ role: "assistant", content: reply });

        await message.reply(reply);

        console.log(
          `🔍 voiceStates has guild: ${voiceStates.has(message.guildId)}, guildId: ${message.guildId}`,
        );
        if (
          voiceStates.has(message.guildId) &&
          (ttsEnabled.get(message.guildId) ?? true)
        ) {
          speakInVoice(message.guildId, reply, "tl");
        }
      } catch (err) {
        console.error("❌ Groq API error:", err.message);
        await message.reply("❌ Failed to get a response. Try again later.");
      }
    }
    return;
  }

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
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const imageNote =
    entry.images.length > 0
      ? `\n🖼️ Images attached: ${entry.images.length}`
      : "";
  const voiceNote = voiceStates.has(pending.guildId)
    ? `\n🔊 Will also be read aloud in voice channel.`
    : "";

  return message.reply(
    `✅ Announcement **#${entry.id}** scheduled!\n` +
      `📌 Channel: <#${entry.channelId}>\n` +
      `🕐 Sends at: \`${sendDate} PHT\`\n` +
      `🗑️ Auto-deletes 1 hour after posting.${imageNote}${voiceNote}`,
  );
});

// HTTP Keep-Alive

const http = require("http");
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is alive!");
  })
  .listen(process.env.PORT || 3000, () =>
    console.log(`🌐 HTTP server running on port ${process.env.PORT || 3000}`),
  );

// Connect to MongoDB, then start bot

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
