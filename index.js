require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const youtubedl = require("youtube-dl-exec");
const { spawn } = require("child_process");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: {
    params: { timeout: 30 },
    interval: 2000,
    autoStart: false,
  },
});

// Clear any stale polling sessions before starting
(async () => {
  try {
    // Drop pending updates and clear webhook
    await bot.deleteWebHook({ drop_pending_updates: true });
    // Wait for old instance to fully die
    await new Promise((r) => setTimeout(r, 5000));
    await bot.startPolling();
    console.log("✅ Polling started successfully");

    // Set up command menu in Telegram
    await bot.setMyCommands([
      { command: 'start', description: '🏠 Show welcome & help' },
      { command: 'clip', description: '✂️ Auto-detect best clips' },
      { command: 'qaclip', description: '❓ Find Q&A moments' },
      { command: 'cut', description: '🔪 Manual cut (start end)' },
      { command: 'clips', description: '🔢 Set number of clips' },
      { command: 'duration', description: '⏱️ Set max clip duration' },
      { command: 'edit', description: '🎬 All editing commands' },
      { command: 'speed', description: '⚡ Change speed (0.5, 1.5, 2)' },
      { command: 'mute', description: '🔇 Remove audio' },
      { command: 'audio', description: '🎵 Extract audio as MP3' },
      { command: 'caption', description: '🎤 Auto-generate captions (AI)' },
      { command: 'text', description: '📝 Add text overlay' },
      { command: 'crop', description: '📐 Crop (9:16, 1:1, 16:9)' },
      { command: 'filter', description: '🎨 Apply visual filter' },
      { command: 'colorgrade', description: '🎨 Cinematic color grading' },
      { command: 'reverse', description: '⏪ Play video backwards' },
      { command: 'fade', description: '🌅 Add fade in/out' },
      { command: 'zoom', description: '🔍 Smooth zoom effect' },
      { command: 'boomerang', description: '🔁 Forward-reverse loop' },
      { command: 'voice', description: '🎭 Voice effects' },
      { command: 'music', description: '🎵 Add background music' },
      { command: 'speedramp', description: '⏩ Speed ramp effect' },
      { command: 'stabilize', description: '🎞️ Stabilize shaky video' },
      { command: 'pip', description: '📌 Picture-in-picture' },
      { command: 'split', description: '🎭 Split screen' },
      { command: 'gif', description: '🎞️ Convert to GIF' },
      { command: 'compress', description: '📉 Reduce file size' },
      { command: 'volume', description: '🔊 Adjust volume' },
      { command: 'resize', description: '📐 Resize video' },
      { command: 'loop', description: '🔁 Loop video N times' },
      { command: 'thumbnail', description: '🖼️ Extract thumbnail' },
      { command: 'merge', description: '🔗 Merge multiple videos' },
      { command: 'stop', description: '🛑 Cancel current operation' },
      { command: 'status', description: '📊 Show session info' },
    ]);
    console.log("📋 Command menu registered");
  } catch (err) {
    console.error("Failed to start polling, retrying in 10s...", err.message);
    setTimeout(async () => {
      try {
        await bot.deleteWebHook({ drop_pending_updates: true });
        await bot.startPolling();
        console.log("✅ Polling started on retry");
      } catch (e) {
        console.error("Polling retry failed:", e.message);
      }
    }, 10000);
  }
})();
const TEMP_DIR = path.join(__dirname, "temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// GramJS client for large file downloads (up to 2GB)
const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
let gramClient = null;

async function initGramClient() {
  if (!API_ID || !API_HASH) {
    console.log("⚠️  No API_ID/API_HASH — large file downloads (>50MB) disabled");
    return;
  }
  const savedSession = process.env.TELEGRAM_SESSION || "";
  gramClient = new TelegramClient(new StringSession(savedSession), API_ID, API_HASH, {
    connectionRetries: 3,
  });
  await gramClient.start({
    botAuthToken: process.env.TELEGRAM_BOT_TOKEN,
  });
  // Save session string for reuse
  const sessionStr = gramClient.session.save();
  if (!savedSession && sessionStr) {
    console.log("💾 Save this session string to .env as TELEGRAM_SESSION:");
    console.log(sessionStr);
  }
  console.log("✅ GramJS client ready — large file downloads enabled");
}

initGramClient().catch((err) => console.error("GramJS init failed:", err.message));

// Smart video sender: tries Bot API first, falls back to GramJS for large files
async function sendVideoSmart(chatId, filePath, options = {}) {
  const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const MAX_BOT_API = 45 * 1024 * 1024; // ~45MB safe limit
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

  // Step 1: Try Bot API if file looks small enough
  if (fileSize < MAX_BOT_API) {
    try {
      return await bot.sendVideo(chatId, filePath, options);
    } catch (err) {
      const is413 = err.message && (err.message.includes("413") || err.message.includes("too large") || err.message.includes("Too Large"));
      if (!is413) throw err;
      console.log(`⚠️ Bot API rejected ${sizeMB}MB file, falling back...`);
      // Fall through to GramJS / compress
    }
  }

  // Step 2: Try GramJS upload (supports up to 2GB)
  if (gramClient) {
    console.log(`📤 Uploading ${sizeMB}MB via GramJS...`);
    try {
      const peer = await gramClient.getInputEntity(chatId);
      await gramClient.sendFile(peer, {
        file: filePath,
        caption: options.caption || "",
        forceDocument: false,
        workers: 4,
      });
      return true;
    } catch (gramErr) {
      console.error("GramJS upload failed:", gramErr.message);
      // Fall through to compress
    }
  }

  // Step 3: Compress and try Bot API
  console.log(`📦 Compressing ${sizeMB}MB for Bot API upload...`);
  const compressedPath = filePath.replace(/\.mp4$/, '_compressed.mp4');
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(filePath).output(compressedPath)
        .outputOptions(['-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'])
        .on('end', resolve).on('error', reject).run();
    });

    let compSize = fs.existsSync(compressedPath) ? fs.statSync(compressedPath).size : 0;

    // If still too big, compress harder with scale down
    if (compSize >= MAX_BOT_API) {
      const hardPath = filePath.replace(/\.mp4$/, '_hard_compressed.mp4');
      await new Promise((resolve, reject) => {
        ffmpeg(filePath).output(hardPath)
          .outputOptions(['-c:v', 'libx264', '-crf', '35', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '64k', '-vf', 'scale=720:-2', '-movflags', '+faststart'])
          .on('end', resolve).on('error', reject).run();
      });
      try { fs.unlinkSync(compressedPath); } catch {}
      const hardSize = fs.existsSync(hardPath) ? fs.statSync(hardPath).size : 0;
      if (hardSize > 0 && hardSize < MAX_BOT_API) {
        await bot.sendMessage(chatId, `⚠️ Original clip was ${sizeMB}MB — sending compressed (720p) version.`);
        const result = await bot.sendVideo(chatId, hardPath, options);
        try { fs.unlinkSync(hardPath); } catch {}
        return result;
      }
      try { fs.unlinkSync(hardPath); } catch {}
      throw new Error(`File too large even after compression (${sizeMB}MB). Try a shorter clip or /compress first.`);
    }

    if (compSize > 0) {
      await bot.sendMessage(chatId, `⚠️ Original clip was ${sizeMB}MB — sending compressed version.`);
      const result = await bot.sendVideo(chatId, compressedPath, options);
      try { fs.unlinkSync(compressedPath); } catch {}
      return result;
    }
  } catch (compErr) {
    console.error("Compression failed:", compErr.message);
  }
  try { fs.unlinkSync(compressedPath); } catch {}

  throw new Error(`File too large to send (${sizeMB}MB). Try /compress first to reduce file size.`);
}

// Whisper transcription via Python (lightweight, runs on demand)

// =============================================
// --- ADMIN & ACCESS CONTROL ---
// =============================================

const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID) || 0;
const ACCESS_CODE = process.env.BOT_ACCESS_CODE || "clipper2024";
const IS_PRIVATE = process.env.BOT_PRIVATE === "true";
console.log(`🔒 Bot mode: ${IS_PRIVATE ? 'PRIVATE' : 'PUBLIC'} | Admin ID: ${ADMIN_ID} | Access code: ${ACCESS_CODE}`);

// Simple JSON file-based storage for users and stats
const DB_PATH = path.join(__dirname, "db.json");
function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch {}
  return { users: {}, stats: { totalClips: 0, totalEdits: 0, totalVideos: 0 } };
}
function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch {}
}

let db = loadDB();

function trackUser(msg) {
  const chatId = msg.chat.id;
  const user = msg.from || {};
  if (!db.users[chatId]) {
    db.users[chatId] = {
      id: chatId,
      username: user.username || "",
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      joinedAt: new Date().toISOString(),
      authorized: !IS_PRIVATE, // auto-authorize if bot is public
      clipCount: 0,
      editCount: 0,
      lastActive: new Date().toISOString(),
    };
  } else {
    db.users[chatId].lastActive = new Date().toISOString();
    db.users[chatId].username = user.username || db.users[chatId].username;
  }
  saveDB(db);
  return db.users[chatId];
}

function isAuthorized(chatId) {
  if (!IS_PRIVATE) return true;
  if (String(chatId) === String(ADMIN_ID)) return true;
  return db.users[chatId] && db.users[chatId].authorized;
}

function trackStat(chatId, type) {
  if (type === "clip") { db.stats.totalClips++; if (db.users[chatId]) db.users[chatId].clipCount++; }
  if (type === "edit") { db.stats.totalEdits++; if (db.users[chatId]) db.users[chatId].editCount++; }
  if (type === "video") db.stats.totalVideos++;
  saveDB(db);
}

// /access CODE - Authorize with access code
bot.onText(/^\/access(?:\s+(.+))?$/, (msg, match) => {
  const chatId = msg.chat.id;
  trackUser(msg);
  if (!IS_PRIVATE) return bot.sendMessage(chatId, "🔓 Bot is public — no access code needed!");
  if (!match[1]) return bot.sendMessage(chatId, "🔒 This bot is private.\n\nUsage: /access YOUR_CODE");
  if (match[1].trim() === ACCESS_CODE) {
    db.users[chatId].authorized = true;
    saveDB(db);
    bot.sendMessage(chatId, "✅ Access granted! You can now use all features.");
  } else {
    bot.sendMessage(chatId, "❌ Invalid access code.");
  }
});

// /admin - Admin dashboard
bot.onText(/^\/admin$/, (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return bot.sendMessage(chatId, "❌ Admin only.");

  const users = Object.values(db.users);
  const authorized = users.filter(u => u.authorized);
  const activeToday = users.filter(u => {
    const last = new Date(u.lastActive);
    const now = new Date();
    return (now - last) < 24 * 60 * 60 * 1000;
  });

  const topUsers = [...users].sort((a, b) => (b.clipCount + b.editCount) - (a.clipCount + a.editCount)).slice(0, 10);

  bot.sendMessage(chatId,
    `📊 *Admin Dashboard*\n\n` +
    `👥 *Users:*\n` +
    `• Total: ${users.length}\n` +
    `• Authorized: ${authorized.length}\n` +
    `• Active today: ${activeToday.length}\n\n` +
    `📈 *Stats:*\n` +
    `• Total videos: ${db.stats.totalVideos}\n` +
    `• Total clips: ${db.stats.totalClips}\n` +
    `• Total edits: ${db.stats.totalEdits}\n\n` +
    `🏆 *Top Users:*\n` +
    topUsers.map((u, i) =>
      `${i + 1}. @${u.username || u.firstName || u.id} — ${u.clipCount} clips, ${u.editCount} edits`
    ).join('\n') +
    `\n\n🔒 Bot is ${IS_PRIVATE ? 'PRIVATE' : 'PUBLIC'}\n` +
    `🔑 Access code: \`${ACCESS_CODE}\`\n\n` +
    `*Admin Commands:*\n` +
    `/admin - This dashboard\n` +
    `/users - List all users\n` +
    `/broadcast MESSAGE - Send to all users\n` +
    `/grant USER_ID - Grant access\n` +
    `/revoke USER_ID - Revoke access`,
    { parse_mode: "Markdown" }
  );
});

// /users - List all users (admin only)
bot.onText(/^\/users$/, (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const users = Object.values(db.users);
  if (users.length === 0) return bot.sendMessage(chatId, "No users yet.");
  const list = users.map(u =>
    `${u.authorized ? '✅' : '❌'} ${u.username ? '@' + u.username : u.firstName || u.id} (${u.id}) — ${u.clipCount}c/${u.editCount}e — last: ${new Date(u.lastActive).toLocaleDateString()}`
  ).join('\n');
  bot.sendMessage(chatId, `👥 *Users (${users.length}):*\n\n${list}`, { parse_mode: "Markdown" });
});

// /broadcast MESSAGE - Send to all users (admin only)
bot.onText(/^\/broadcast\s+(.+)$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const message = match[1];
  const users = Object.values(db.users);
  let sent = 0, failed = 0;
  for (const user of users) {
    try {
      await bot.sendMessage(user.id, `📢 *Announcement:*\n\n${message}`, { parse_mode: "Markdown" });
      sent++;
    } catch { failed++; }
  }
  bot.sendMessage(chatId, `📢 Broadcast: ${sent} sent, ${failed} failed.`);
});

// /grant USER_ID - Grant access (admin only)
bot.onText(/^\/grant\s+(\d+)$/, (msg, match) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const userId = match[1];
  if (db.users[userId]) {
    db.users[userId].authorized = true;
    saveDB(db);
    bot.sendMessage(chatId, `✅ Access granted to ${userId}`);
    bot.sendMessage(userId, "✅ You've been granted access to the bot!").catch(() => {});
  } else {
    bot.sendMessage(chatId, `❌ User ${userId} not found. They need to /start the bot first.`);
  }
});

// /revoke USER_ID - Revoke access (admin only)
bot.onText(/^\/revoke\s+(\d+)$/, (msg, match) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const userId = match[1];
  if (db.users[userId]) {
    db.users[userId].authorized = false;
    saveDB(db);
    bot.sendMessage(chatId, `🚫 Access revoked for ${userId}`);
  } else {
    bot.sendMessage(chatId, `❌ User ${userId} not found.`);
  }
});

// Global auth check — block unauthorized users from ALL commands except /start and /access
const blockedMsgs = new Set();
bot.on("message", (msg) => {
  if (!msg.text) return;
  trackUser(msg);
  if (IS_PRIVATE && !isAuthorized(msg.chat.id) && msg.text.startsWith("/") &&
      !msg.text.startsWith("/start") && !msg.text.startsWith("/access") &&
      !msg.text.startsWith("/admin") && !msg.text.startsWith("/users") &&
      !msg.text.startsWith("/broadcast") && !msg.text.startsWith("/grant") &&
      !msg.text.startsWith("/revoke")) {
    blockedMsgs.add(msg.message_id);
    bot.sendMessage(msg.chat.id, "🔒 This bot is private.\n\nSend /access YOUR_CODE to unlock.");
  }
});

// Also block unauthorized video/file/audio uploads
bot.on("video", (msg) => { trackUser(msg); if (IS_PRIVATE && !isAuthorized(msg.chat.id)) { blockedMsgs.add(msg.message_id); bot.sendMessage(msg.chat.id, "🔒 Send /access CODE first."); } });
bot.on("document", (msg) => { trackUser(msg); if (IS_PRIVATE && !isAuthorized(msg.chat.id)) { blockedMsgs.add(msg.message_id); bot.sendMessage(msg.chat.id, "🔒 Send /access CODE first."); } });
bot.on("audio", (msg) => { trackUser(msg); if (IS_PRIVATE && !isAuthorized(msg.chat.id)) { blockedMsgs.add(msg.message_id); bot.sendMessage(msg.chat.id, "🔒 Send /access CODE first."); } });

// Helper to check if message was already blocked
function isBlocked(msg) { if (blockedMsgs.has(msg.message_id)) { blockedMsgs.delete(msg.message_id); return true; } return false; }

// Track user sessions
const sessions = {};
let processingLock = false;
let activeProcess = null; // Track active FFmpeg/child process for cancellation
let cancelRequested = {}; // Track cancel per chat

// /stop - Cancel current operation
bot.onText(/\/stop/, (msg) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  cancelRequested[chatId] = true;

  // Kill active child process if any
  if (activeProcess && activeProcess.kill) {
    try { activeProcess.kill('SIGKILL'); } catch {}
    activeProcess = null;
  }

  processingLock = false;

  // Clean up temp files for this session
  const session = sessions[chatId];
  if (session && session.videoPath) {
    try { fs.unlinkSync(session.videoPath); } catch {}
  }
  delete sessions[chatId];

  bot.sendMessage(chatId, "🛑 *Operation cancelled.* Send a new video to start fresh.", { parse_mode: "Markdown" });
});

// /status - Show current session info
bot.onText(/\/status/, (msg) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session) {
    return bot.sendMessage(chatId, "📊 *Status:* No active session.\nSend a video to get started.", { parse_mode: "Markdown" });
  }
  const info = [
    `📊 *Session Status*`,
    ``,
    `📁 Video: ${session.videoPath ? '✅ Loaded' : '❌ None'}`,
    `⏱️ Max duration: ${session.clipDuration || 60}s`,
    `🔢 Clip count: ${session.clipCount || 3}`,
    `⚙️ Processing: ${processingLock ? '🔄 In progress...' : '💤 Idle'}`,
  ];
  bot.sendMessage(chatId, info.join('\n'), { parse_mode: "Markdown" });
});

bot.onText(/\/start/, (msg) => {
  trackUser(msg);
  if (!isAuthorized(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id,
      `🔒 This bot is private.\n\nYou need an access code to use it.\n\nSend: /access YOUR_CODE`
    );
  }
  bot.sendMessage(
    msg.chat.id,
    `🎬 *Telegram Clipper Bot*\n\n` +
      `Send me a video (upload or URL) and I'll find the best clips automatically!\n\n` +
      `*✂️ Clipping:*\n` +
      `/clip - Auto-detect and cut best clips\n` +
      `/clip 60 - Auto-clip with custom duration\n` +
      `/qaclip - Find Q&A moments with captions\n` +
      `/cut HH:MM:SS HH:MM:SS - Manual cut\n` +
      `/clips 5 - Set number of clips\n` +
      `/duration 60 - Set max clip duration\n\n` +
      `*🎬 Editing:*\n` +
      `/edit - Show all editing commands\n` +
      `/caption - AI auto-captions (CapCut style)\n` +
      `/colorgrade - Cinematic color grading\n` +
      `/reverse - Play backwards\n` +
      `/speedramp - Speed ramp effect\n\n` +
      `*⚙️ General:*\n` +
      `/stop - Cancel current operation\n` +
      `/status - Show session info\n\n` +
      `Also supports YouTube, Twitter/X, Instagram, TikTok links!`,
    { parse_mode: "Markdown" }
  );
});

const COMMANDS_TEXT = "📋 Commands:\n/clip - Auto-detect best moments\n/clip 60 - Custom clip duration\n/qaclip - Find Q&A moments\n/cut 00:01:30 00:02:45 - Manual cut\n/clips 5 - Set number of clips\n/duration 60 - Set max duration";

// Handle video uploads
bot.on("video", async (msg) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  trackUser(msg);
  if (!isAuthorized(chatId)) return;
  trackStat(chatId, "video");
  const fileId = msg.video.file_id;
  const fileSize = msg.video.file_size || 0;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

  try {
    const dlMsg = await bot.sendMessage(chatId, `⬇️ Downloading video (${sizeMB} MB)...`);
    const startTime = Date.now();
    const filePath = await downloadTelegramFile(fileId, msg);
    const dlTime = ((Date.now() - startTime) / 1000).toFixed(1);
    await updateProgress(chatId, dlMsg.message_id, `✅ Video received! (${sizeMB} MB in ${dlTime}s)\n\n${COMMANDS_TEXT}`);
    if (sessions[chatId] && sessions[chatId].videoPath) {
      // Second video — save for /pip and /split
      sessions[chatId].secondVideoPath = filePath;
      bot.sendMessage(chatId, "📌 Second video saved! Use /pip or /split to combine them.");
    } else {
      sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
    }
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Handle document videos (when sent as file)
bot.on("document", async (msg) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  const mime = msg.document.mime_type || "";
  if (!mime.startsWith("video/")) return;
  const fileSize = msg.document.file_size || 0;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

  try {
    const dlMsg = await bot.sendMessage(chatId, `⬇️ Downloading video (${sizeMB} MB)...`);
    const startTime = Date.now();
    const filePath = await downloadTelegramFile(msg.document.file_id, msg);
    const dlTime = ((Date.now() - startTime) / 1000).toFixed(1);
    await updateProgress(chatId, dlMsg.message_id, `✅ Video received! (${sizeMB} MB in ${dlTime}s)\n\n${COMMANDS_TEXT}`);
    if (sessions[chatId] && sessions[chatId].videoPath) {
      sessions[chatId].secondVideoPath = filePath;
      bot.sendMessage(chatId, "📌 Second video saved! Use /pip or /split to combine them.");
    } else {
      sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
    }
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Handle audio uploads (for /music command)
bot.on("audio", async (msg) => {
  const chatId = msg.chat.id;
  try {
    const file = await bot.getFile(msg.audio.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const ext = path.extname(file.file_path) || ".mp3";
    const dest = path.join(TEMP_DIR, `music_${chatId}${ext}`);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      https.get(url, (res) => { res.pipe(ws); ws.on("finish", () => { ws.close(); resolve(); }); }).on("error", reject);
    });
    if (!sessions[chatId]) sessions[chatId] = {};
    sessions[chatId].audioPath = dest;
    bot.sendMessage(chatId, "🎵 Audio saved! Now use /music to add it as background music to your video.");
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to save audio: ${err.message}`);
  }
});

// Handle voice messages (for /music command)
bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  try {
    const file = await bot.getFile(msg.voice.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const dest = path.join(TEMP_DIR, `music_${chatId}.ogg`);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      https.get(url, (res) => { res.pipe(ws); ws.on("finish", () => { ws.close(); resolve(); }); }).on("error", reject);
    });
    if (!sessions[chatId]) sessions[chatId] = {};
    sessions[chatId].audioPath = dest;
    bot.sendMessage(chatId, "🎵 Audio saved! Now use /music to add it as background music.");
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to save audio: ${err.message}`);
  }
});

// Handle direct video URLs
bot.onText(/^(https?:\/\/\S+\.(mp4|mkv|avi|mov|webm)(\?\S*)?)$/i, async (msg, match) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  const url = match[1];

  try {
    const dlMsg = await bot.sendMessage(chatId, "⬇️ Downloading video from URL...");
    const startTime = Date.now();
    const filePath = await downloadFromUrl(url, chatId);
    const dlTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
    await updateProgress(chatId, dlMsg.message_id, `✅ Video downloaded! (${sizeMB} MB in ${dlTime}s)\n\n${COMMANDS_TEXT}`);
    sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Handle YouTube, Twitter/X, Instagram, TikTok, and other social media URLs
const socialPattern = /^(https?:\/\/\S*(youtube\.com|youtu\.be|twitter\.com|x\.com|instagram\.com|tiktok\.com|facebook\.com|fb\.watch|vimeo\.com|reddit\.com|twitch\.tv|drive\.google\.com)\S*)$/i;
bot.onText(socialPattern, async (msg, match) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  const url = match[1];

  try {
    const dlMsg = await bot.sendMessage(chatId, "⬇️ Downloading video from social media...\n⏳ This may take a moment...");
    const startTime = Date.now();

    // Update progress every 10 seconds
    const progressInterval = setInterval(async () => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      try {
        await bot.editMessageText(`⬇️ Downloading video... (${elapsed}s elapsed)`, { chat_id: chatId, message_id: dlMsg.message_id });
      } catch {}
    }, 10000);

    const filePath = await downloadWithYtdlp(url, chatId);
    clearInterval(progressInterval);

    const dlTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
    await updateProgress(chatId, dlMsg.message_id, `✅ Video downloaded! (${sizeMB} MB in ${dlTime}s)\n\n${COMMANDS_TEXT}`);
    sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Set number of clips
bot.onText(/^\/clips(?:\s+(\d+))?$/, (msg, match) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  if (!sessions[chatId]) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) {
    return bot.sendMessage(chatId, `🔢 Current clip count: *${sessions[chatId].clipCount || 3}*\n\nUsage: /clips 5`, { parse_mode: "Markdown" });
  }
  sessions[chatId].clipCount = parseInt(match[1]);
  bot.sendMessage(chatId, `✅ Will generate ${match[1]} clips.`);
});

// Set clip duration
bot.onText(/^\/duration(?:\s+(\d+))?$/, (msg, match) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  if (!sessions[chatId]) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) {
    return bot.sendMessage(chatId, `⏱️ Current max duration: *${sessions[chatId].clipDuration || 60}s*\n\nUsage: /duration 60`, { parse_mode: "Markdown" });
  }
  sessions[chatId].clipDuration = parseInt(match[1]);
  bot.sendMessage(chatId, `✅ Max clip duration set to ${match[1]}s.`);
});

// Animated progress helpers
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LOADING_BAR = ['▱▱▱▱▱', '▰▱▱▱▱', '▰▰▱▱▱', '▰▰▰▱▱', '▰▰▰▰▱', '▰▰▰▰▰'];
const FILM_FRAMES = ['🎬', '🎥', '📽️', '🎞️'];

function createProgressBar(percent) {
  const filled = Math.round(percent / 10);
  const empty = 10 - filled;
  return '▰'.repeat(filled) + '▱'.repeat(empty) + ` ${percent}%`;
}

// Start an animated spinner that updates the message
function startSpinner(chatId, msgId, getText) {
  let frame = 0;
  const interval = setInterval(async () => {
    const spinner = SPINNER[frame % SPINNER.length];
    const film = FILM_FRAMES[frame % FILM_FRAMES.length];
    try {
      await bot.editMessageText(getText(spinner, film), { chat_id: chatId, message_id: msgId });
    } catch {}
    frame++;
  }, 2000);
  return interval;
}

// Helper to update a progress message
async function updateProgress(chatId, msgId, text) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId });
  } catch {}
  return msgId;
}

// Auto clip
bot.onText(/^\/clip(?:\s+(\d+))?$/, async (msg, match) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.videoPath) {
    return bot.sendMessage(chatId, "Send a video first.");
  }
  if (match[1]) session.clipDuration = parseInt(match[1]);

  if (processingLock) {
    return bot.sendMessage(chatId, "⏳ Another video is being processed. Please wait...");
  }
  processingLock = true;

  try {
    const duration = await getVideoDuration(session.videoPath);
    const durationStr = formatTime(duration);
    const statusMsg = await bot.sendMessage(chatId,
      `🎬 Analyzing ${durationStr} video...\n\n` +
      `${createProgressBar(0)}\n\n` +
      `⠋ Step 1/4: Detecting scene changes...`
    );
    const mid = statusMsg.message_id;

    // Animated spinner during scene detection
    let spinnerAnim = startSpinner(chatId, mid, (s, f) =>
      `${f} Analyzing ${durationStr} video...\n\n` +
      `${createProgressBar(10)}\n\n` +
      `${s} Detecting scene changes...`
    );

    const startTime = Date.now();
    const scenes = await detectScenes(session.videoPath);
    clearInterval(spinnerAnim);
    const sceneTime = ((Date.now() - startTime) / 1000).toFixed(0);

    await updateProgress(chatId, mid,
      `🎬 Analyzing ${durationStr} video...\n\n` +
      `${createProgressBar(40)}\n\n` +
      `✅ Scenes: ${scenes.length} found (${sceneTime}s)\n` +
      `⠋ Analyzing audio peaks...`
    );

    // Animated spinner during audio analysis
    spinnerAnim = startSpinner(chatId, mid, (s, f) =>
      `${f} Analyzing ${durationStr} video...\n\n` +
      `${createProgressBar(60)}\n\n` +
      `✅ Scenes: ${scenes.length} found (${sceneTime}s)\n` +
      `${s} Analyzing audio peaks...`
    );

    const audioStart = Date.now();
    const audioPeaks = await detectAudioPeaks(session.videoPath);
    clearInterval(spinnerAnim);
    const audioTime = ((Date.now() - audioStart) / 1000).toFixed(0);

    await updateProgress(chatId, mid,
      `🎬 Analyzing ${durationStr} video...\n\n` +
      `${createProgressBar(80)}\n\n` +
      `✅ Scenes: ${scenes.length} found (${sceneTime}s)\n` +
      `✅ Audio: ${audioPeaks.length} peaks (${audioTime}s)\n` +
      `⠹ Scoring highlights...`
    );

    const highlights = scoreSegments(scenes, audioPeaks, duration, session.clipCount, session.clipDuration);

    if (highlights.length === 0) {
      return updateProgress(chatId, mid, "❌ No highlights found. Try /cut manually.");
    }

    await updateProgress(chatId, mid,
      `🎬 Analysis complete!\n\n` +
      `${createProgressBar(100)}\n\n` +
      `✅ Scenes: ${scenes.length} found (${sceneTime}s)\n` +
      `✅ Audio: ${audioPeaks.length} peaks (${audioTime}s)\n` +
      `✅ ${highlights.length} highlight(s) found\n\n` +
      `✂️ Cutting clips...`
    );

    cancelRequested[chatId] = false;
    for (let i = 0; i < highlights.length; i++) {
      if (cancelRequested[chatId]) {
        await updateProgress(chatId, mid, "🛑 Cancelled.");
        break;
      }
      const { start, end } = highlights[i];
      const clipDur = (end - start).toFixed(0);
      const outPath = path.join(TEMP_DIR, `clip_${chatId}_${i}.mp4`);

      const clipBar = createProgressBar(Math.round(((i + 1) / highlights.length) * 100));
      await updateProgress(chatId, mid,
        `✂️ Cutting & uploading...\n\n` +
        `${clipBar}\n\n` +
        `🎞️ Clip ${i + 1}/${highlights.length}\n` +
        `⏱️ ${formatTime(start)} → ${formatTime(end)} (${clipDur}s)`
      );

      await cutVideo(session.videoPath, start, end, outPath);

      await sendVideoSmart(chatId, outPath, {
        caption: `🎬 Clip ${i + 1}/${highlights.length} (${formatTime(start)} → ${formatTime(end)}, ${clipDur}s)`,
      });

      fs.unlinkSync(outPath);
    }

    // Clean up source video to free disk space
    try { fs.unlinkSync(session.videoPath); } catch {}
    delete sessions[chatId];

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
    await updateProgress(chatId, mid,
      `🎉 All done!\n\n` +
      `⏱️ Total time: ${totalTime}s\n` +
      `🎞️ ${highlights.length} clips generated\n\n` +
      `📊 Clip Summary:\n` +
      highlights.map((h, i) =>
        `  ${i + 1}. 🕐 ${formatTime(h.start)} → ${formatTime(h.end)} (${(h.end - h.start).toFixed(0)}s)`
      ).join('\n') +
      `\n\n💡 Send another video or /clip again!`
    );
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  } finally {
    processingLock = false;
  }
});

// Q&A clip — transcribe, find questions, clip answers with question as caption
bot.onText(/\/qaclip(?:\s+(\d+))?$/, async (msg, match) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.videoPath) {
    return bot.sendMessage(chatId, "Send a video first.");
  }

  const clipDuration = match[1] ? parseInt(match[1]) : session.clipDuration;

  if (processingLock) {
    return bot.sendMessage(chatId, "⏳ Another video is being processed. Please wait...");
  }
  processingLock = true;

  try {
    const videoDuration = await getVideoDuration(session.videoPath);
    const estMinutes = Math.ceil(videoDuration / 60);

    // Process in 5-minute chunks to avoid OOM
    const CHUNK_MINS = 5;
    const CHUNK_SECS = CHUNK_MINS * 60;
    const totalChunks = Math.ceil(videoDuration / CHUNK_SECS);

    bot.sendMessage(chatId, `🎙️ Transcribing ~${estMinutes} min video in ${totalChunks} chunks...\n⏳ Processing ${CHUNK_MINS} minutes at a time to save memory`);

    let allChunks = [];
    for (let c = 0; c < totalChunks; c++) {
      if (cancelRequested[chatId]) break;
      const offset = c * CHUNK_SECS;
      bot.sendMessage(chatId, `📊 Chunk ${c + 1}/${totalChunks}: Extracting audio (${formatTime(offset)} - ${formatTime(Math.min(offset + CHUNK_SECS, videoDuration))})...`);

      const wavPath = path.join(TEMP_DIR, `audio_${chatId}_${c}.wav`);
      // Extract only this chunk
      await new Promise((resolve, reject) => {
        ffmpeg(session.videoPath).output(wavPath)
          .outputOptions(["-ss", String(offset), "-t", String(CHUNK_SECS), "-ar", "16000", "-ac", "1", "-f", "wav"])
          .on("end", resolve).on("error", reject).run();
      });

      bot.sendMessage(chatId, `📊 Chunk ${c + 1}/${totalChunks}: Transcribing with AI...`);
      try {
        const chunks = await transcribeWithWhisper(wavPath);
        // Adjust timestamps to absolute video time
        for (const chunk of chunks) {
          chunk.timestamp[0] += offset;
          chunk.timestamp[1] += offset;
        }
        allChunks = allChunks.concat(chunks);
      } catch (err) {
        bot.sendMessage(chatId, `⚠️ Chunk ${c + 1} failed: ${err.message}. Skipping...`);
      }
      try { fs.unlinkSync(wavPath); } catch {}
    }

    const chunks = allChunks;

    // Find questions in the transcript
    // Show what was transcribed so user can verify
    const transcriptPreview = chunks.slice(0, 10).map((c, idx) => `${idx + 1}. [${formatTime(c.timestamp[0])}] "${c.text}"`).join('\n');
    bot.sendMessage(chatId, `📊 Step 3/3: Found ${chunks.length} text segments. Searching for Q&A moments...\n\n📝 Transcript preview:\n${transcriptPreview}${chunks.length > 10 ? `\n...and ${chunks.length - 10} more` : ''}`);
    const qaClips = extractQASegments(chunks, clipDuration);

    if (qaClips.length === 0) {
      // Show all segments so user can see what went wrong
      const allTexts = chunks.map((c, idx) => `${idx + 1}. [${formatTime(c.timestamp[0])}] "${c.text}"`).join('\n');
      const debugMsg = allTexts.length > 3500 ? allTexts.slice(0, 3500) + '...' : allTexts;
      return bot.sendMessage(chatId, `❌ No questions detected in the transcript.\n\n📝 Full transcript:\n${debugMsg}\n\n💡 Tip: The AI transcription may not have captured the questions clearly. Try /clip for auto-highlights instead.`);
    }

    // Limit to user's clip count setting
    const maxClips = session.clipCount || 3;
    const clipsToSend = qaClips.slice(0, maxClips);
    bot.sendMessage(chatId, `❓ Found ${qaClips.length} Q&A moment(s). Sending top ${clipsToSend.length} clips...`);

    for (let i = 0; i < clipsToSend.length; i++) {
      const { question, start, end } = clipsToSend[i];
      const outPath = path.join(TEMP_DIR, `qa_${chatId}_${i}.mp4`);

      bot.sendMessage(chatId, `✂️ Clip ${i + 1}/${clipsToSend.length}: Cutting ${formatTime(start)} → ${formatTime(end)}...`);
      await cutVideo(session.videoPath, start, end, outPath);

      bot.sendMessage(chatId, `📤 Clip ${i + 1}/${clipsToSend.length}: Sending...`);
      const caption = `❓ ${question}\n\n🎬 Clip ${i + 1}/${clipsToSend.length} (${formatTime(start)} → ${formatTime(end)})`;
      await sendVideoSmart(chatId, outPath, {
        caption: caption.slice(0, 1024),
      });

      try { fs.unlinkSync(outPath); } catch {}
    }

    // Clean up source video to free disk space
    try { fs.unlinkSync(session.videoPath); } catch {}
    delete sessions[chatId];

    bot.sendMessage(chatId, "✅ All Q&A clips sent!");
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  } finally {
    processingLock = false;
  }
});

// Manual cut - show usage if no args
bot.onText(/^\/cut$/, (msg) => {
  if (isBlocked(msg)) return;
  bot.sendMessage(msg.chat.id, `🔪 *Manual Cut*\n\nUsage: /cut START END\n\nExamples:\n/cut 00:01:30 00:02:45\n/cut 90 165\n/cut 1:30 2:45`, { parse_mode: "Markdown" });
});

// Manual cut with arguments
bot.onText(/\/cut\s+(\S+)\s+(\S+)/, async (msg, match) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.videoPath) {
    return bot.sendMessage(chatId, "Send a video first.");
  }

  const start = parseTime(match[1]);
  const end = parseTime(match[2]);

  if (start === null || end === null || end <= start) {
    return bot.sendMessage(chatId, "Invalid time format. Use HH:MM:SS or MM:SS or seconds.");
  }

  try {
    bot.sendMessage(chatId, `✂️ Cutting ${formatTime(start)} → ${formatTime(end)}...`);
    const outPath = path.join(TEMP_DIR, `manual_${chatId}.mp4`);
    await cutVideo(session.videoPath, start, end, outPath);
    await sendVideoSmart(chatId, outPath, {
      caption: `🎬 Clip (${formatTime(start)} → ${formatTime(end)})`,
    });
    fs.unlinkSync(outPath);

    // Clean up source video to free disk space
    try { fs.unlinkSync(session.videoPath); } catch {}
    delete sessions[chatId];
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// =============================================
// --- VIDEO EDITING SECTION ---
// =============================================

// /edit - Show editing menu
bot.onText(/^\/edit$/, (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.videoPath) {
    return bot.sendMessage(chatId, "Send a video first.");
  }
  bot.sendMessage(chatId,
    `🎬 *Video Editor*\n\n` +
    `*⚡ Speed & Time:*\n` +
    `/speed 1.5 - Change speed\n` +
    `/reverse - Play backwards\n` +
    `/boomerang - Forward-reverse loop\n` +
    `/speedramp - Smooth speed ramp\n` +
    `/loop 3 - Loop video N times\n\n` +
    `*🎨 Visual & Color:*\n` +
    `/text Your Text - Text overlay\n` +
    `/crop 9:16 - Crop (9:16, 1:1, 16:9)\n` +
    `/filter grayscale - Visual filter\n` +
    `/colorgrade cinematic - Color grading\n` +
    `/fade - Fade in/out\n` +
    `/zoom in - Smooth zoom effect\n\n` +
    `*🎤 Audio:*\n` +
    `/mute - Remove audio\n` +
    `/audio - Extract as MP3\n` +
    `/volume 1.5 - Adjust volume\n` +
    `/voice deep - Voice effects\n` +
    `/music - Add background music\n` +
    `/musiclib - Browse royalty-free music\n\n` +
    `*🤖 AI Features:*\n` +
    `/caption - Auto-generate captions\n\n` +
    `*🎬 Advanced:*\n` +
    `/stabilize - Fix shaky footage\n` +
    `/pip - Picture-in-picture\n` +
    `/split - Split screen (2 videos)\n` +
    `/bgremove green - Green screen removal\n` +
    `/thumbnail 5 - Extract frame at time\n\n` +
    `*📦 Format:*\n` +
    `/gif - Convert to GIF\n` +
    `/compress - Reduce file size\n` +
    `/resize 1280x720 - Resize\n` +
    `/merge - Merge videos`,
    { parse_mode: "Markdown" }
  );
});

// /speed - Change playback speed
bot.onText(/^\/speed(?:\s+([\d.]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) return bot.sendMessage(chatId, "Usage: /speed 1.5\n\nExamples:\n/speed 0.5 (slow motion)\n/speed 2 (2x fast)\n/speed 0.25 (super slow)");

  const speed = parseFloat(match[1]);
  if (speed <= 0 || speed > 10) return bot.sendMessage(chatId, "Speed must be between 0.1 and 10.");

  try {
    bot.sendMessage(chatId, `⚡ Changing speed to ${speed}x...`);
    const outPath = path.join(TEMP_DIR, `speed_${chatId}.mp4`);
    const videoFilter = `setpts=${(1/speed).toFixed(4)}*PTS`;
    const audioFilter = `atempo=${speed > 2 ? 2 : speed < 0.5 ? 0.5 : speed}`;

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions(["-vf", videoFilter, "-af", audioFilter, "-preset", "ultrafast"])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    await sendVideoSmart(chatId, outPath, { caption: `⚡ Speed: ${speed}x` });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /mute - Remove audio
bot.onText(/^\/mute$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");

  try {
    bot.sendMessage(chatId, "🔇 Removing audio...");
    const outPath = path.join(TEMP_DIR, `mute_${chatId}.mp4`);

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions(["-c:v", "copy", "-an"])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    await sendVideoSmart(chatId, outPath, { caption: "🔇 Audio removed" });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /audio - Extract audio as MP3
bot.onText(/^\/audio$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");

  try {
    bot.sendMessage(chatId, "🎵 Extracting audio...");
    const outPath = path.join(TEMP_DIR, `audio_${chatId}.mp3`);

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions(["-vn", "-acodec", "libmp3lame", "-q:a", "2"])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    await bot.sendAudio(chatId, outPath, { caption: "🎵 Extracted audio" });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /text - Add text overlay
bot.onText(/^\/text\s+(.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");

  const text = match[1].replace(/'/g, "\\'");

  try {
    bot.sendMessage(chatId, `📝 Adding text: "${match[1]}"...`);
    const outPath = path.join(TEMP_DIR, `text_${chatId}.mp4`);

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions([
          "-vf", `drawtext=text='${text}':fontsize=48:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-th-40`,
          "-c:a", "copy",
          "-preset", "ultrafast"
        ])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    await sendVideoSmart(chatId, outPath, { caption: `📝 Text: "${match[1]}"` });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

bot.onText(/^\/text$/, (msg) => {
  bot.sendMessage(msg.chat.id, "Usage: /text Your Text Here");
});

// /crop - Crop to aspect ratio
bot.onText(/^\/crop(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) return bot.sendMessage(chatId, "Usage: /crop RATIO\n\nExamples:\n/crop 9:16 (TikTok/Reels)\n/crop 1:1 (Square)\n/crop 16:9 (YouTube)\n/crop 4:5 (Instagram)");

  const ratio = match[1];
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return bot.sendMessage(chatId, "Invalid ratio. Use format like 9:16, 1:1, 16:9");

  try {
    bot.sendMessage(chatId, `📐 Cropping to ${ratio}...`);
    const outPath = path.join(TEMP_DIR, `crop_${chatId}.mp4`);
    const cropFilter = `crop=min(iw\\,ih*${w}/${h}):min(ih\\,iw*${h}/${w})`;

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions(["-vf", cropFilter, "-c:a", "copy", "-preset", "ultrafast"])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    await sendVideoSmart(chatId, outPath, { caption: `📐 Cropped to ${ratio}` });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /filter - Apply visual filter
bot.onText(/^\/filter(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) return bot.sendMessage(chatId,
    "Usage: /filter NAME\n\n" +
    "Available filters:\n" +
    "• grayscale - Black & white\n" +
    "• sepia - Warm vintage tone\n" +
    "• bright - Increase brightness\n" +
    "• dark - Decrease brightness\n" +
    "• contrast - High contrast\n" +
    "• blur - Gaussian blur\n" +
    "• sharpen - Sharpen video\n" +
    "• mirror - Horizontal flip\n" +
    "• flip - Vertical flip\n" +
    "• negative - Invert colors"
  );

  const filters = {
    grayscale: "colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3",
    sepia: "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
    bright: "eq=brightness=0.15",
    dark: "eq=brightness=-0.15",
    contrast: "eq=contrast=1.5",
    blur: "boxblur=5:1",
    sharpen: "unsharp=5:5:1.5",
    mirror: "hflip",
    flip: "vflip",
    negative: "negate",
  };

  const filterName = match[1].toLowerCase();
  if (!filters[filterName]) return bot.sendMessage(chatId, `Unknown filter. Use /filter to see available options.`);

  try {
    bot.sendMessage(chatId, `🎨 Applying ${filterName} filter...`);
    const outPath = path.join(TEMP_DIR, `filter_${chatId}.mp4`);

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions(["-vf", filters[filterName], "-c:a", "copy", "-preset", "ultrafast"])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    await sendVideoSmart(chatId, outPath, { caption: `🎨 Filter: ${filterName}` });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /gif - Convert to GIF
bot.onText(/^\/gif$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");

  try {
    bot.sendMessage(chatId, "🎞️ Converting to GIF...");
    const outPath = path.join(TEMP_DIR, `gif_${chatId}.gif`);

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions(["-vf", "fps=15,scale=480:-1:flags=lanczos", "-t", "15"])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    await bot.sendAnimation(chatId, outPath, { caption: "🎞️ GIF (max 15s, 480px)" });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /compress - Reduce file size
bot.onText(/^\/compress$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");

  try {
    const origSize = (fs.statSync(session.videoPath).size / 1024 / 1024).toFixed(1);
    bot.sendMessage(chatId, `📉 Compressing video (${origSize} MB)...`);
    const outPath = path.join(TEMP_DIR, `compress_${chatId}.mp4`);

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions(["-c:v", "libx264", "-crf", "28", "-preset", "fast", "-c:a", "aac", "-b:a", "96k", "-vf", "scale=-2:720"])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    const newSize = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    await sendVideoSmart(chatId, outPath, { caption: `📉 Compressed: ${origSize} MB → ${newSize} MB` });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /volume - Adjust audio volume
bot.onText(/^\/volume(?:\s+([\d.]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) return bot.sendMessage(chatId, "Usage: /volume 1.5\n\nExamples:\n/volume 0.5 (50% quieter)\n/volume 2 (2x louder)\n/volume 3 (3x louder)");

  const vol = parseFloat(match[1]);
  if (vol <= 0 || vol > 10) return bot.sendMessage(chatId, "Volume must be between 0.1 and 10.");

  try {
    bot.sendMessage(chatId, `🔊 Setting volume to ${vol}x...`);
    const outPath = path.join(TEMP_DIR, `volume_${chatId}.mp4`);

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions(["-c:v", "copy", "-af", `volume=${vol}`])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    await sendVideoSmart(chatId, outPath, { caption: `🔊 Volume: ${vol}x` });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /resize - Resize video
bot.onText(/^\/resize(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) return bot.sendMessage(chatId, "Usage: /resize WIDTHxHEIGHT\n\nExamples:\n/resize 1920x1080\n/resize 1280x720\n/resize 640x480");

  const [w, h] = match[1].split("x").map(Number);
  if (!w || !h) return bot.sendMessage(chatId, "Invalid format. Use WIDTHxHEIGHT (e.g. 1280x720)");

  try {
    bot.sendMessage(chatId, `📐 Resizing to ${w}x${h}...`);
    const outPath = path.join(TEMP_DIR, `resize_${chatId}.mp4`);

    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath)
        .output(outPath)
        .outputOptions(["-vf", `scale=${w}:${h}`, "-c:a", "copy", "-preset", "ultrafast"])
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    await sendVideoSmart(chatId, outPath, { caption: `📐 Resized to ${w}x${h}` });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /merge - Merge multiple videos
bot.onText(/^\/merge$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.mergeList || session.mergeList.length < 2) {
    return bot.sendMessage(chatId, "Send 2+ videos first, then use /merge.\n\nTip: Send videos one by one, then /merge to combine them.");
  }

  try {
    bot.sendMessage(chatId, `🔗 Merging ${session.mergeList.length} videos...`);
    const listPath = path.join(TEMP_DIR, `merge_${chatId}.txt`);
    const outPath = path.join(TEMP_DIR, `merged_${chatId}.mp4`);

    const listContent = session.mergeList.map(f => `file '${f}'`).join("\n");
    fs.writeFileSync(listPath, listContent);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .output(outPath)
        .outputOptions(["-c", "copy"])
        .on("end", resolve)
        .on("error", () => {
          // Fallback: re-encode if concat fails
          ffmpeg()
            .input(listPath)
            .inputOptions(["-f", "concat", "-safe", "0"])
            .output(outPath)
            .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-preset", "ultrafast"])
            .on("end", resolve)
            .on("error", reject)
            .run();
        })
        .run();
    });

    fs.unlinkSync(listPath);
    await sendVideoSmart(chatId, outPath, { caption: `🔗 Merged ${session.mergeList.length} videos` });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// =============================================
// --- PRO EDITING TOOLS ---
// =============================================

// /reverse - Play video backwards
bot.onText(/^\/reverse$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  try {
    bot.sendMessage(chatId, "⏪ Reversing video...");
    const outPath = path.join(TEMP_DIR, `reverse_${chatId}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(outPath)
        .outputOptions(["-vf", "reverse", "-af", "areverse", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: "⏪ Reversed" });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /fade - Fade in/out
bot.onText(/^\/fade(?:\s+([\d.]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  const fadeDur = parseFloat(match[1]) || 1;
  try {
    bot.sendMessage(chatId, `🌅 Adding ${fadeDur}s fade in/out...`);
    const outPath = path.join(TEMP_DIR, `fade_${chatId}.mp4`);
    const duration = await getVideoDuration(session.videoPath);
    const fadeOut = duration - fadeDur;
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(outPath)
        .outputOptions([
          "-vf", `fade=t=in:st=0:d=${fadeDur},fade=t=out:st=${fadeOut}:d=${fadeDur}`,
          "-af", `afade=t=in:st=0:d=${fadeDur},afade=t=out:st=${fadeOut}:d=${fadeDur}`,
          "-preset", "ultrafast"
        ])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: `🌅 Fade in/out (${fadeDur}s)` });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /boomerang - Forward then reverse
bot.onText(/^\/boomerang$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  try {
    bot.sendMessage(chatId, "🔁 Creating boomerang...");
    const fwd = path.join(TEMP_DIR, `boom_fwd_${chatId}.mp4`);
    const rev = path.join(TEMP_DIR, `boom_rev_${chatId}.mp4`);
    const outPath = path.join(TEMP_DIR, `boomerang_${chatId}.mp4`);
    // Limit to first 3 seconds
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(fwd)
        .outputOptions(["-t", "3", "-c:v", "libx264", "-an", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });
    await new Promise((resolve, reject) => {
      ffmpeg(fwd).output(rev)
        .outputOptions(["-vf", "reverse", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });
    // Concat forward + reverse
    const listPath = path.join(TEMP_DIR, `boom_list_${chatId}.txt`);
    fs.writeFileSync(listPath, `file '${fwd}'\nfile '${rev}'`);
    await new Promise((resolve, reject) => {
      ffmpeg().input(listPath).inputOptions(["-f", "concat", "-safe", "0"]).output(outPath)
        .outputOptions(["-c", "copy"])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: "🔁 Boomerang" });
    [fwd, rev, listPath, outPath].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /zoom - Smooth zoom in/out
bot.onText(/^\/zoom(?:\s+(in|out))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  const direction = (match[1] || "in").toLowerCase();
  try {
    bot.sendMessage(chatId, `🔍 Applying smooth zoom ${direction}...`);
    const outPath = path.join(TEMP_DIR, `zoom_${chatId}.mp4`);
    const zoomFilter = direction === "in"
      ? "zoompan=z='min(zoom+0.001,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30"
      : "zoompan=z='if(eq(on,1),1.5,max(zoom-0.001,1))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30";
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(outPath)
        .outputOptions(["-vf", zoomFilter, "-c:a", "copy", "-preset", "ultrafast", "-t", "10"])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: `🔍 Zoom ${direction}` });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /stabilize - Fix shaky footage
bot.onText(/^\/stabilize$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  try {
    bot.sendMessage(chatId, "🎞️ Stabilizing video (2 passes)...\n⏳ This may take a while...");
    const outPath = path.join(TEMP_DIR, `stable_${chatId}.mp4`);
    const transformPath = path.join(TEMP_DIR, `transforms_${chatId}.trf`);
    // Pass 1: Detect motion
    await new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-i", session.videoPath, "-vf", `vidstabdetect=stepsize=6:shakiness=8:result=${transformPath}`,
        "-f", "null", "-"
      ], { stdio: "pipe" });
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error("Stabilize pass 1 failed")));
      proc.on("error", reject);
    });
    // Pass 2: Apply stabilization
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(outPath)
        .outputOptions(["-vf", `vidstabtransform=input=${transformPath}:smoothing=10,unsharp=5:5:0.8:3:3:0.4`, "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: "🎞️ Stabilized" });
    [outPath, transformPath].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /caption - Auto-generate AI captions (CapCut style)
bot.onText(/^\/caption$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  try {
    const statusMsg = await bot.sendMessage(chatId, "🎤 Generating AI captions...\n\n📊 Extracting & transcribing in chunks...");
    const videoDuration = await getVideoDuration(session.videoPath);
    const CHUNK_MINS = 5;
    const CHUNK_SECS = CHUNK_MINS * 60;
    const totalChunks = Math.ceil(videoDuration / CHUNK_SECS);

    let chunks = [];
    for (let c = 0; c < totalChunks; c++) {
      const offset = c * CHUNK_SECS;
      await updateProgress(chatId, statusMsg.message_id,
        `🎤 Generating AI captions...\n\n📊 Chunk ${c + 1}/${totalChunks}: ${formatTime(offset)} - ${formatTime(Math.min(offset + CHUNK_SECS, videoDuration))}`
      );
      const wavPath = path.join(TEMP_DIR, `caption_audio_${chatId}_${c}.wav`);
      await new Promise((resolve, reject) => {
        ffmpeg(session.videoPath).output(wavPath)
          .outputOptions(["-ss", String(offset), "-t", String(CHUNK_SECS), "-ar", "16000", "-ac", "1", "-f", "wav"])
          .on("end", resolve).on("error", reject).run();
      });
      try {
        const result = await transcribeWithWhisper(wavPath);
        for (const chunk of result) { chunk.timestamp[0] += offset; chunk.timestamp[1] += offset; }
        chunks = chunks.concat(result);
      } catch (err) {
        await updateProgress(chatId, statusMsg.message_id, `⚠️ Chunk ${c + 1} failed: ${err.message}. Continuing...`);
      }
      try { fs.unlinkSync(wavPath); } catch {}
    }

    if (!chunks || chunks.length === 0) {
      return updateProgress(chatId, statusMsg.message_id, "❌ No speech detected in the video.");
    }

    await updateProgress(chatId, statusMsg.message_id, `🎤 Generating AI captions...\n\n📊 Step 3/3: Burning ${chunks.length} subtitles onto video...`);

    // Generate ASS subtitle file (CapCut style)
    const assPath = path.join(TEMP_DIR, `subs_${chatId}.ass`);
    let assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,2,10,10,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    for (const chunk of chunks) {
      const startTime = formatASSTime(chunk.timestamp[0]);
      const endTime = formatASSTime(chunk.timestamp[1]);
      const text = chunk.text.replace(/\n/g, "\\N");
      assContent += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}\n`;
    }
    fs.writeFileSync(assPath, assContent);

    const outPath = path.join(TEMP_DIR, `captioned_${chatId}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(outPath)
        .outputOptions(["-vf", `ass=${assPath}`, "-c:a", "copy", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });

    await sendVideoSmart(chatId, outPath, { caption: `🎤 Auto-captioned (${chunks.length} segments)` });
    [outPath, assPath].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    await updateProgress(chatId, statusMsg.message_id, `✅ Captions added! ${chunks.length} segments burned onto video.`);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /musiclib - Browse and add royalty-free music
bot.onText(/^\/musiclib(?:\s+(.+))?$/, async (msg, match) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");

  if (!match[1]) {
    // Show mood categories with inline keyboard
    return bot.sendMessage(chatId,
      `🎵 *Music Library*\n\nPick a mood or search:\n\n` +
      `/musiclib energetic - Upbeat, action\n` +
      `/musiclib chill - Relaxed, lo-fi\n` +
      `/musiclib dramatic - Cinematic, epic\n` +
      `/musiclib happy - Feel good, positive\n` +
      `/musiclib sad - Emotional, melancholy\n` +
      `/musiclib hip hop - Hip hop beats\n` +
      `/musiclib electronic - EDM, synth\n` +
      `/musiclib acoustic - Guitar, piano\n` +
      `/musiclib jazz - Smooth jazz\n` +
      `/musiclib rock - Rock, indie\n\n` +
      `Or search anything: /musiclib your search term`,
      { parse_mode: "Markdown" }
    );
  }

  const query = match[1].trim();
  const PIXABAY_KEY = process.env.PIXABAY_API_KEY;

  if (!PIXABAY_KEY) {
    // Fallback: use yt-dlp to download from YouTube Audio Library
    try {
      bot.sendMessage(chatId, `🔍 Searching for "${query}" music...`);
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query + " royalty free music no copyright")}&sp=EgIQAQ%253D%253D`;
      const dest = path.join(TEMP_DIR, `musiclib_${chatId}.mp3`);

      await new Promise((resolve, reject) => {
        const ytOpts = {
          output: dest,
          extractAudio: true,
          audioFormat: "mp3",
          audioQuality: 5,
          noCheckCertificates: true,
          noWarnings: true,
          defaultSearch: "ytsearch1",
          format: "bestaudio",
        };
        const cookiesPath = path.join(__dirname, "cookies.txt");
        if (fs.existsSync(cookiesPath)) ytOpts.cookies = cookiesPath;
        youtubedl(`ytsearch1:${query}`, ytOpts)
          .then(resolve).catch(reject);
      });

      // Find the downloaded file
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(`musiclib_${chatId}`));
      let audioFile = dest;
      if (!fs.existsSync(dest) && files.length > 0) {
        audioFile = path.join(TEMP_DIR, files[0]);
      }

      if (!fs.existsSync(audioFile)) {
        return bot.sendMessage(chatId, "❌ Couldn't find music. Try a different search term.");
      }

      session.audioPath = audioFile;

      // Send preview
      try {
        await bot.sendAudio(chatId, audioFile, {
          caption: `🎵 Found: "${query}" music\n\n✅ Use /music to add it to your video\n🔊 /music 0.5 to set volume`,
        });
      } catch {
        bot.sendMessage(chatId, `🎵 Music found for "${query}"!\n\n✅ Use /music to add it to your video\n🔊 /music 0.5 to set volume`);
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error finding music: ${err.message}`);
    }
    return;
  }

  // Use Pixabay API
  try {
    bot.sendMessage(chatId, `🔍 Searching "${query}" in music library...`);
    const apiUrl = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&media_type=music&per_page=5`;

    const data = await new Promise((resolve, reject) => {
      https.get(apiUrl, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch { reject(new Error("Bad API response")); }
        });
      }).on("error", reject);
    });

    if (!data.hits || data.hits.length === 0) {
      return bot.sendMessage(chatId, `❌ No music found for "${query}". Try another term.`);
    }

    // Store results in session for selection
    session.musicResults = data.hits;

    let msg_text = `🎵 *Found ${data.hits.length} tracks for "${query}":*\n\n`;
    data.hits.forEach((track, i) => {
      const dur = Math.floor(track.duration / 60) + ":" + String(track.duration % 60).padStart(2, "0");
      msg_text += `${i + 1}. 🎶 ${track.tags || "Untitled"} (${dur})\n`;
    });
    msg_text += `\nSelect: /musicpick 1 (or 2, 3, etc.)`;

    bot.sendMessage(chatId, msg_text, { parse_mode: "Markdown" });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// /musicpick N - Pick a track from musiclib results
bot.onText(/^\/musicpick\s+(\d+)$/, async (msg, match) => {
  if (isBlocked(msg)) return;
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");

  if (session.musicResults) {
    // Pixabay results
    const idx = parseInt(match[1]) - 1;
    if (!session.musicResults[idx]) return bot.sendMessage(chatId, "Invalid selection.");
    const track = session.musicResults[idx];

    try {
      bot.sendMessage(chatId, `⬇️ Downloading "${track.tags}"...`);
      const dest = path.join(TEMP_DIR, `musicpick_${chatId}.mp3`);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        https.get(track.previewURL || track.audio, (res) => {
          res.pipe(ws);
          ws.on("finish", () => { ws.close(); resolve(); });
        }).on("error", reject);
      });
      session.audioPath = dest;
      bot.sendMessage(chatId, `✅ "${track.tags}" selected!\n\nUse /music to add it to your video\n🔊 /music 0.5 to set volume`);
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  } else {
    bot.sendMessage(chatId, "Use /musiclib first to search for music.");
  }
});

// /music - Add background music
bot.onText(/^\/music(?:\s+([\d.]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!session.audioPath) return bot.sendMessage(chatId, "🎵 Send an audio file first, then use /music to overlay it.\n\nOptional: /music 0.3 (set music volume, default 0.3)");
  const musicVol = parseFloat(match[1]) || 0.3;
  try {
    bot.sendMessage(chatId, `🎵 Adding background music (volume: ${musicVol})...`);
    const outPath = path.join(TEMP_DIR, `music_out_${chatId}.mp4`);
    const duration = await getVideoDuration(session.videoPath);
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).input(session.audioPath).output(outPath)
        .outputOptions([
          "-filter_complex", `[1:a]volume=${musicVol},aloop=loop=-1:size=2e+09[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
          "-map", "0:v", "-map", "[aout]",
          "-c:v", "copy", "-shortest", "-preset", "ultrafast"
        ])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: `🎵 Background music added (vol: ${musicVol})` });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /voice - Voice effects
bot.onText(/^\/voice(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) return bot.sendMessage(chatId,
    "🎭 *Voice Effects*\n\n" +
    "/voice deep - Deep/bass voice\n" +
    "/voice high - High pitched\n" +
    "/voice echo - Echo effect\n" +
    "/voice reverb - Reverb/hall\n" +
    "/voice robot - Robotic voice\n" +
    "/voice whisper - Whisper effect\n" +
    "/voice telephone - Phone call effect",
    { parse_mode: "Markdown" }
  );

  const effects = {
    deep: "asetrate=44100*0.75,aresample=44100,atempo=1.333",
    high: "asetrate=44100*1.5,aresample=44100,atempo=0.666",
    echo: "aecho=0.8:0.88:60:0.4",
    reverb: "aecho=0.8:0.9:1000:0.3",
    robot: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
    whisper: "highpass=f=1000,lowpass=f=3000,volume=2",
    telephone: "highpass=f=300,lowpass=f=3400,volume=1.5",
  };

  const effect = match[1].toLowerCase();
  if (!effects[effect]) return bot.sendMessage(chatId, "Unknown effect. Use /voice to see options.");

  try {
    bot.sendMessage(chatId, `🎭 Applying ${effect} voice effect...`);
    const outPath = path.join(TEMP_DIR, `voice_${chatId}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(outPath)
        .outputOptions(["-af", effects[effect], "-c:v", "copy", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: `🎭 Voice: ${effect}` });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /colorgrade - Cinematic color grading
bot.onText(/^\/colorgrade(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) return bot.sendMessage(chatId,
    "🎨 *Color Grading*\n\n" +
    "/colorgrade cinematic - Teal & orange film look\n" +
    "/colorgrade warm - Warm golden tones\n" +
    "/colorgrade cool - Cool blue tones\n" +
    "/colorgrade vintage - Retro faded look\n" +
    "/colorgrade dramatic - High contrast moody\n" +
    "/colorgrade pastel - Soft pastel colors\n" +
    "/colorgrade noir - Dark film noir",
    { parse_mode: "Markdown" }
  );

  const grades = {
    cinematic: "curves=r='0/0 0.25/0.2 0.5/0.5 0.75/0.8 1/1':g='0/0 0.25/0.22 0.5/0.47 0.75/0.77 1/0.95':b='0/0.05 0.25/0.3 0.5/0.52 0.75/0.72 1/0.9',eq=saturation=1.2:contrast=1.1",
    warm: "colortemperature=temperature=6500,eq=saturation=1.15:brightness=0.05",
    cool: "colortemperature=temperature=3500,eq=saturation=0.9:contrast=1.1",
    vintage: "curves=vintage,eq=saturation=0.8:brightness=0.05:contrast=0.95",
    dramatic: "eq=contrast=1.5:brightness=-0.05:saturation=1.3",
    pastel: "eq=saturation=0.7:brightness=0.1:contrast=0.9",
    noir: "colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3,eq=contrast=1.4:brightness=-0.05",
  };

  const grade = match[1].toLowerCase();
  if (!grades[grade]) return bot.sendMessage(chatId, "Unknown grade. Use /colorgrade to see options.");

  try {
    bot.sendMessage(chatId, `🎨 Applying ${grade} color grade...`);
    const outPath = path.join(TEMP_DIR, `grade_${chatId}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(outPath)
        .outputOptions(["-vf", grades[grade], "-c:a", "copy", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: `🎨 Color grade: ${grade}` });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /speedramp - Speed ramp effect
bot.onText(/^\/speedramp$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  try {
    bot.sendMessage(chatId, "⏩ Creating speed ramp (slow → fast → slow)...");
    const outPath = path.join(TEMP_DIR, `ramp_${chatId}.mp4`);
    const duration = await getVideoDuration(session.videoPath);
    // Split into 3 parts: slow(0.5x), fast(2x), slow(0.5x)
    const third = duration / 3;
    const p1 = path.join(TEMP_DIR, `ramp1_${chatId}.mp4`);
    const p2 = path.join(TEMP_DIR, `ramp2_${chatId}.mp4`);
    const p3 = path.join(TEMP_DIR, `ramp3_${chatId}.mp4`);

    // Part 1: Slow
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(p1)
        .outputOptions(["-t", String(third), "-vf", "setpts=2*PTS", "-af", "atempo=0.5", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });
    // Part 2: Fast
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(p2)
        .outputOptions(["-ss", String(third), "-t", String(third), "-vf", "setpts=0.5*PTS", "-af", "atempo=2", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });
    // Part 3: Slow
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(p3)
        .outputOptions(["-ss", String(third * 2), "-vf", "setpts=2*PTS", "-af", "atempo=0.5", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });

    // Concat
    const listPath = path.join(TEMP_DIR, `ramp_list_${chatId}.txt`);
    fs.writeFileSync(listPath, `file '${p1}'\nfile '${p2}'\nfile '${p3}'`);
    await new Promise((resolve, reject) => {
      ffmpeg().input(listPath).inputOptions(["-f", "concat", "-safe", "0"]).output(outPath)
        .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });

    await sendVideoSmart(chatId, outPath, { caption: "⏩ Speed ramp: slow → fast → slow" });
    [p1, p2, p3, listPath, outPath].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /pip - Picture-in-picture
bot.onText(/^\/pip(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!session.secondVideoPath) return bot.sendMessage(chatId, "📌 Send a second video first, then use /pip.\n\nThe second video will be overlaid as a small box.\n\nPositions: /pip topright /pip topleft /pip bottomright /pip bottomleft");
  const position = (match[1] || "bottomright").toLowerCase();
  const positions = {
    topright: "main_w-overlay_w-10:10",
    topleft: "10:10",
    bottomright: "main_w-overlay_w-10:main_h-overlay_h-10",
    bottomleft: "10:main_h-overlay_h-10",
  };
  const pos = positions[position] || positions.bottomright;
  try {
    bot.sendMessage(chatId, `📌 Creating picture-in-picture (${position})...`);
    const outPath = path.join(TEMP_DIR, `pip_${chatId}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).input(session.secondVideoPath).output(outPath)
        .outputOptions([
          "-filter_complex", `[1:v]scale=iw/4:ih/4[pip];[0:v][pip]overlay=${pos}[out]`,
          "-map", "[out]", "-map", "0:a?",
          "-c:v", "libx264", "-preset", "ultrafast", "-shortest"
        ])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: `📌 Picture-in-picture (${position})` });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /split - Split screen
bot.onText(/^\/split(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!session.secondVideoPath) return bot.sendMessage(chatId, "🎭 Send a second video first, then use /split.\n\nOptions: /split horizontal /split vertical");
  const layout = (match[1] || "horizontal").toLowerCase();
  try {
    bot.sendMessage(chatId, `🎭 Creating ${layout} split screen...`);
    const outPath = path.join(TEMP_DIR, `split_${chatId}.mp4`);
    const filter = layout === "vertical"
      ? "[0:v]scale=1920:540[top];[1:v]scale=1920:540[bot];[top][bot]vstack[out]"
      : "[0:v]scale=960:1080[left];[1:v]scale=960:1080[right];[left][right]hstack[out]";
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).input(session.secondVideoPath).output(outPath)
        .outputOptions(["-filter_complex", filter, "-map", "[out]", "-map", "0:a?", "-preset", "ultrafast", "-shortest"])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: `🎭 Split screen (${layout})` });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /bgremove - Green screen removal
bot.onText(/^\/bgremove(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  const color = (match[1] || "green").toLowerCase();
  const colors = { green: "0x00FF00", blue: "0x0000FF", white: "0xFFFFFF", red: "0xFF0000" };
  if (!colors[color]) return bot.sendMessage(chatId, "Usage: /bgremove green\n\nColors: green, blue, white, red");
  try {
    bot.sendMessage(chatId, `🟢 Removing ${color} background...`);
    const outPath = path.join(TEMP_DIR, `bgremove_${chatId}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(outPath)
        .outputOptions(["-vf", `chromakey=${colors[color]}:0.15:0.15`, "-c:a", "copy", "-preset", "ultrafast"])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: `🟢 ${color} background removed` });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /loop - Loop video N times
bot.onText(/^\/loop(?:\s+(\d+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  if (!match[1]) return bot.sendMessage(chatId, "Usage: /loop 3\n\nLoops the video N times (max 10).");
  const loops = Math.min(parseInt(match[1]), 10);
  try {
    bot.sendMessage(chatId, `🔁 Looping video ${loops} times...`);
    const outPath = path.join(TEMP_DIR, `loop_${chatId}.mp4`);
    const listPath = path.join(TEMP_DIR, `loop_list_${chatId}.txt`);
    const entries = Array(loops).fill(`file '${session.videoPath}'`).join("\n");
    fs.writeFileSync(listPath, entries);
    await new Promise((resolve, reject) => {
      ffmpeg().input(listPath).inputOptions(["-f", "concat", "-safe", "0"]).output(outPath)
        .outputOptions(["-c", "copy"])
        .on("end", resolve).on("error", reject).run();
    });
    await sendVideoSmart(chatId, outPath, { caption: `🔁 Looped ${loops}x` });
    [outPath, listPath].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// /thumbnail - Extract thumbnail
bot.onText(/^\/thumbnail(?:\s+([\d:.]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (isBlocked(msg)) return;
  if (!session || !session.videoPath) return bot.sendMessage(chatId, "Send a video first.");
  const time = match[1] ? parseTime(match[1]) || 5 : 5;
  try {
    bot.sendMessage(chatId, `🖼️ Extracting thumbnail at ${formatTime(time)}...`);
    const outPath = path.join(TEMP_DIR, `thumb_${chatId}.jpg`);
    await new Promise((resolve, reject) => {
      ffmpeg(session.videoPath).output(outPath)
        .outputOptions(["-ss", String(time), "-frames:v", "1", "-q:v", "2"])
        .on("end", resolve).on("error", reject).run();
    });
    await bot.sendPhoto(chatId, outPath, { caption: `🖼️ Thumbnail at ${formatTime(time)}` });
    fs.unlinkSync(outPath);
  } catch (err) { bot.sendMessage(chatId, `❌ Error: ${err.message}`); }
});

// Helper: Format ASS subtitle timestamp
function formatASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// =============================================
// --- Core Functions ---
// =============================================

async function downloadTelegramFile(fileId, msg) {
  // Try Bot API first (works for files <50MB)
  try {
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const ext = path.extname(file.file_path) || ".mp4";
    const dest = path.join(TEMP_DIR, `${Date.now()}${ext}`);

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      https.get(url, (res) => {
        res.pipe(ws);
        ws.on("finish", () => { ws.close(); resolve(); });
      }).on("error", reject);
    });

    return dest;
  } catch (err) {
    // If file too big, fall back to GramJS
    if (err.message && err.message.includes("file is too big")) {
      return downloadWithGramJS(msg);
    }
    throw err;
  }
}

async function downloadWithGramJS(msg) {
  if (!gramClient) {
    throw new Error("File is too large (>50MB). Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env to enable large downloads.");
  }

  const dest = path.join(TEMP_DIR, `${Date.now()}_large.mp4`);

  // Fetch the message through GramJS to access media
  let gramMessage = null;

  try {
    const messages = await gramClient.getMessages(msg.chat.id, {
      ids: [msg.message_id],
    });
    if (messages && messages.length > 0) gramMessage = messages[0];
  } catch {
    try {
      const messages = await gramClient.getMessages(
        new Api.PeerUser({ userId: msg.chat.id }),
        { ids: [msg.message_id] }
      );
      if (messages && messages.length > 0) gramMessage = messages[0];
    } catch {}
  }

  if (!gramMessage) {
    throw new Error("Could not fetch message for large file download");
  }

  await gramClient.downloadMedia(gramMessage, { outputFile: dest });

  if (!fs.existsSync(dest)) {
    throw new Error("GramJS download failed");
  }

  return dest;
}

function transcribeWithWhisper(wavPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [path.join(__dirname, "transcribe.py"), wavPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_DISABLE_SYMLINKS_WARNING: "1", TOKENIZERS_PARALLELISM: "false" },
    });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code, signal) => {
      // Try to parse stdout first regardless of exit code (warnings go to stderr)
      try {
        const chunks = JSON.parse(stdout);
        if (chunks.length > 0) return resolve(chunks);
      } catch {}
      // Detect OOM kill
      if (signal === 'SIGKILL' || code === 137) {
        return reject(new Error("Out of memory — video too large for transcription. Try a shorter video or use /clip instead."));
      }
      // If stdout parsing failed AND exit code is non-zero, report error
      if (code !== 0) {
        const realErrors = stderr.split('\n').filter(l => !l.includes('Warning') && !l.includes('FutureWarning') && l.trim()).join('\n');
        return reject(new Error(`Transcription failed: ${realErrors || stderr || 'Unknown error (exit code ' + code + ')'}`));
      }
      reject(new Error("No transcription output"));
    });

    proc.on("error", reject);
  });
}

function extractAudio(videoPath, wavPath, maxDuration) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoPath)
      .output(wavPath)
      .outputOptions(["-ar", "16000", "-ac", "1", "-f", "wav"]);
    if (maxDuration) cmd.outputOptions(["-t", String(maxDuration)]);
    cmd.on("end", resolve).on("error", reject).run();
  });
}

function isQuestion(text) {
  const lower = text.toLowerCase().trim();

  // Explicit question mark
  if (lower.includes("?")) return true;

  // Starts with common question words/phrases
  const questionStarters = [
    /^(who|what|where|when|why|how|which|whose|whom)\b/,
    /^(is|are|was|were|will|would|could|can|should|shall|do|does|did|have|has|had)\b.*\b(you|we|they|it|he|she|that|this|there)\b/,
    /^(is|are|was|were|will|would|could|can|should|shall|do|does|did|have|has|had)\s+(it|you|we|they|he|she|that|this|there)\b/,
    /^(tell me|explain|describe|talk about|what's|what is|how do|how does|how did|how is|how are|how was)/,
    /^(can you|could you|would you|do you|don't you|didn't you|isn't it|aren't you|won't you)/,
    /^(so what|and what|but what|then what|okay so what|ok so what|alright so what)/,
    /^(what do you think|what does that mean|what happened|what about|how about)/,
    /^(why do|why does|why did|why is|why are|why was|why would|why can)/,
    /^(have you ever|has anyone|is there|are there|was there|were there)/,
  ];

  for (const regex of questionStarters) {
    if (regex.test(lower)) return true;
  }

  // Contains strong question indicators mid-sentence
  const questionPhrases = [
    /\b(what do you think)\b/,
    /\b(how do you feel)\b/,
    /\b(can you tell)\b/,
    /\b(would you say)\b/,
    /\b(what's your|what is your)\b/,
    /\b(right\s*$)/,  // ends with "right" (tag question)
    /\b(you know\s*$)/, // ends with "you know" (tag question)
  ];

  for (const regex of questionPhrases) {
    if (regex.test(lower)) return true;
  }

  return false;
}

function extractQASegments(chunks, maxClipDuration) {
  const qaClips = [];
  const MAX_QA_DURATION = 60; // max 1 minute per clip

  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i].text.trim();
    if (!text) continue;

    // Detect questions using smart detection
    if (isQuestion(text)) {
      const question = text;

      // Answer starts RIGHT AFTER the question ends (not including the question)
      const answerStart = chunks[i].timestamp[1] || chunks[i].timestamp[0];
      let answerEnd = answerStart;

      // Collect answer from following chunks until next question or 60s limit
      for (let j = i + 1; j < chunks.length; j++) {
        const nextText = chunks[j].text.trim();
        const nextEnd = chunks[j].timestamp[1] || chunks[j].timestamp[0];

        // Stop if we hit another question or exceed 60 seconds
        if (isQuestion(nextText) || nextEnd - answerStart > MAX_QA_DURATION) {
          break;
        }
        answerEnd = nextEnd;
      }

      // Skip if no answer found (question at end of video)
      if (answerEnd <= answerStart) continue;

      // Minimum 30 seconds, max 60 seconds
      const MIN_QA_DURATION = 30;
      const clipEnd = Math.min(Math.max(answerEnd, answerStart + MIN_QA_DURATION), answerStart + MAX_QA_DURATION);

      qaClips.push({
        question: question,
        start: answerStart,
        end: clipEnd,
      });
    }
  }

  // Remove overlapping clips
  const filtered = [];
  for (const clip of qaClips) {
    const overlaps = filtered.some(c => clip.start < c.end && clip.end > c.start);
    if (!overlaps) filtered.push(clip);
  }

  return filtered;
}

async function downloadWithYtdlp(url, chatId) {
  const basename = `${Date.now()}_${chatId}`;
  const dest = path.join(TEMP_DIR, `${basename}.mp4`);

  // 5 minute timeout for downloads
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Download timed out after 15 minutes")), 15 * 60 * 1000)
  );

  const ytdlpOpts = {
    output: path.join(TEMP_DIR, `${basename}.%(ext)s`),
    format: "bv*+ba/b",
    mergeOutputFormat: "mp4",
    noCheckCertificates: true,
    noWarnings: true,
    concurrentFragments: 4,
  };

  // Use cookies if available
  const cookiesPath = path.join(__dirname, "cookies.txt");
  if (fs.existsSync(cookiesPath)) {
    ytdlpOpts.cookies = cookiesPath;
  }

  const download = youtubedl(url, ytdlpOpts);

  await Promise.race([download, timeout]);

  // yt-dlp may save with a slightly different name, find the actual file
  if (fs.existsSync(dest)) return dest;

  const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(basename));
  if (files.length > 0) {
    const actual = path.join(TEMP_DIR, files[0]);
    if (actual !== dest) fs.renameSync(actual, dest);
    return dest;
  }

  throw new Error("yt-dlp download failed");
}

function downloadFromUrl(url, chatId) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(new URL(url).pathname).split("?")[0] || ".mp4";
    const dest = path.join(TEMP_DIR, `${Date.now()}_${chatId}${ext}`);
    const ws = fs.createWriteStream(dest);
    const client = url.startsWith("https") ? https : http;

    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        downloadFromUrl(res.headers.location, chatId).then(resolve).catch(reject);
        ws.close();
        fs.unlinkSync(dest);
        return;
      }
      res.pipe(ws);
      ws.on("finish", () => {
        ws.close();
        resolve(dest);
      });
    }).on("error", reject);
  });
}

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

function detectScenes(filePath) {
  return new Promise((resolve, reject) => {
    const scenes = [];
    const { spawn } = require("child_process");
    const proc = spawn("ffmpeg", [
      "-i", filePath,
      "-vf", "fps=0.5,select='gt(scene,0.3)',showinfo",
      "-vsync", "vfr",
      "-f", "null",
      "-"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const timeout = setTimeout(() => {
      proc.kill();
      resolve(scenes);
    }, 3 * 60 * 1000);

    // Process line by line instead of buffering all stderr
    let partial = "";
    proc.stderr.on("data", (data) => {
      partial += data.toString();
      const lines = partial.split("\n");
      partial = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const match = line.match(/pts_time:(\d+\.?\d*)/);
        if (match) scenes.push(parseFloat(match[1]));
      }
    });

    proc.on("close", () => {
      clearTimeout(timeout);
      // Process remaining
      if (partial) {
        const match = partial.match(/pts_time:(\d+\.?\d*)/);
        if (match) scenes.push(parseFloat(match[1]));
      }
      resolve(scenes);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function detectAudioPeaks(filePath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const peaks = [];
    // Downsample to 8kHz mono for speed and memory
    const proc = spawn("ffmpeg", [
      "-i", filePath,
      "-af", "aresample=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-ac", "1",
      "-f", "null",
      "-"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const timeout = setTimeout(() => {
      proc.kill();
      peaks.sort((a, b) => b.level - a.level);
      resolve(peaks);
    }, 3 * 60 * 1000);

    let frameTime = 0;
    let partial = "";
    proc.stdout.on("data", (data) => {
      partial += data.toString();
      const lines = partial.split("\n");
      partial = lines.pop();
      for (const line of lines) {
        const timeMatch = line.match(/pts_time:(\d+\.?\d*)/);
        if (timeMatch) frameTime = parseFloat(timeMatch[1]);
        const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
        if (rmsMatch) {
          const rms = parseFloat(rmsMatch[1]);
          if (rms > -30) {
            peaks.push({ time: frameTime, level: rms });
          }
        }
      }
    });

    proc.on("close", () => {
      clearTimeout(timeout);
      peaks.sort((a, b) => b.level - a.level);
      resolve(peaks);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function scoreSegments(scenes, audioPeaks, totalDuration, clipCount, clipDuration) {
  const MAX_DURATION = 60; // never exceed 1 minute
  const segments = [];

  // Sort scenes chronologically
  const sortedScenes = [...scenes].sort((a, b) => a - b);

  // Create candidate segments — each clip starts at a scene change and ends at the next one
  for (let i = 0; i < sortedScenes.length; i++) {
    const start = Math.max(0, sortedScenes[i] - 2);
    // Find next scene change for natural end point
    const nextScene = sortedScenes[i + 1] || sortedScenes[i] + 15;
    // Dynamic duration: use distance to next scene, but cap at MAX_DURATION
    const naturalEnd = Math.min(nextScene + 2, start + MAX_DURATION, totalDuration);
    // Minimum 30 seconds
    const end = Math.min(Math.max(naturalEnd, start + 30), start + MAX_DURATION, totalDuration);

    let score = 1;

    // Boost score if audio peaks are nearby
    for (const peak of audioPeaks) {
      if (peak.time >= start && peak.time <= end) {
        score += (peak.level + 50) / 10;
      }
    }

    segments.push({ start, end, score });
  }

  // Also add segments around top audio peaks with dynamic duration
  for (const peak of audioPeaks.slice(0, 10)) {
    const start = Math.max(0, peak.time - 5);
    // Find nearest scene change after peak for natural end
    const nextScene = sortedScenes.find(s => s > peak.time) || peak.time + 20;
    const end = Math.min(nextScene + 2, start + MAX_DURATION, totalDuration);
    const score = (peak.level + 50) / 5;
    segments.push({ start, end, score });
  }

  // If no highlights found, split video into equal parts
  if (segments.length === 0) {
    const segLen = totalDuration / clipCount;
    for (let i = 0; i < clipCount; i++) {
      const start = i * segLen;
      const end = Math.min(start + Math.min(segLen, MAX_DURATION), totalDuration);
      segments.push({ start, end, score: 1 });
    }
  }

  // Sort by score, remove overlaps, take top N
  segments.sort((a, b) => b.score - a.score);
  const selected = [];

  for (const seg of segments) {
    if (selected.length >= clipCount) break;
    const overlaps = selected.some(
      (s) => seg.start < s.end && seg.end > s.start
    );
    if (!overlaps) {
      selected.push(seg);
    }
  }

  // Sort by time order
  selected.sort((a, b) => a.start - b.start);
  return selected;
}

function cutVideo(inputPath, start, end, outputPath) {
  return new Promise((resolve, reject) => {
    // Try stream copy first (instant, no re-encoding)
    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(end - start)
      .output(outputPath)
      .outputOptions(["-c", "copy", "-avoid_negative_ts", "make_zero"])
      .on("end", resolve)
      .on("error", () => {
        // Fallback to re-encode if copy fails
        ffmpeg(inputPath)
          .setStartTime(start)
          .setDuration(end - start)
          .output(outputPath)
          .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-preset", "ultrafast"])
          .on("end", resolve)
          .on("error", reject)
          .run();
      })
      .run();
  });
}

function parseTime(str) {
  // Supports HH:MM:SS, MM:SS, or raw seconds
  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Health endpoint + Admin Web Dashboard
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  const dashKey = process.env.DASHBOARD_KEY || "admin123";
  if (req.url === `/dashboard?key=${dashKey}` || req.url === `/admin?key=${dashKey}`) {
    const users = Object.values(db.users);
    const authorized = users.filter(u => u.authorized);
    const activeToday = users.filter(u => (Date.now() - new Date(u.lastActive)) < 86400000);
    const html = `<!DOCTYPE html><html><head><title>Clipper Bot Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f0f0f;color:#fff;padding:20px}
.card{background:#1a1a2e;border-radius:12px;padding:20px;margin:10px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:#16213e;border-radius:8px;padding:15px;text-align:center}
.stat .num{font-size:2em;font-weight:bold;color:#00d2ff}
.stat .label{color:#888;font-size:0.85em;margin-top:5px}
h1{color:#00d2ff;margin-bottom:15px}
h2{color:#e94560;margin:15px 0 10px}
table{width:100%;border-collapse:collapse}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #222}
th{color:#00d2ff}
.badge{padding:2px 8px;border-radius:4px;font-size:0.8em}
.badge.yes{background:#0f5132;color:#75b798}
.badge.no{background:#58151c;color:#ea868f}
</style></head><body>
<h1>🎬 Clipper Bot Dashboard</h1>
<div class="stats">
  <div class="stat"><div class="num">${users.length}</div><div class="label">Total Users</div></div>
  <div class="stat"><div class="num">${authorized.length}</div><div class="label">Authorized</div></div>
  <div class="stat"><div class="num">${activeToday.length}</div><div class="label">Active Today</div></div>
  <div class="stat"><div class="num">${db.stats.totalVideos}</div><div class="label">Videos</div></div>
  <div class="stat"><div class="num">${db.stats.totalClips}</div><div class="label">Clips Made</div></div>
  <div class="stat"><div class="num">${db.stats.totalEdits}</div><div class="label">Edits Made</div></div>
</div>
<div class="card"><h2>👥 Users</h2>
<table><tr><th>User</th><th>ID</th><th>Access</th><th>Clips</th><th>Edits</th><th>Last Active</th></tr>
${users.map(u => `<tr>
  <td>@${u.username || u.firstName || 'unknown'}</td>
  <td>${u.id}</td>
  <td><span class="badge ${u.authorized ? 'yes' : 'no'}">${u.authorized ? 'Yes' : 'No'}</span></td>
  <td>${u.clipCount}</td>
  <td>${u.editCount}</td>
  <td>${new Date(u.lastActive).toLocaleDateString()}</td>
</tr>`).join('')}
</table></div>
<div class="card"><p style="color:#888">🔒 Bot is ${IS_PRIVATE ? 'PRIVATE' : 'PUBLIC'} | Auto-refreshes on page load</p></div>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } else {
    res.writeHead(200);
    res.end("Telegram Clipper Bot is running");
  }
});
server.listen(PORT, () => {
  console.log(`🎬 Telegram Clipper Bot is running! (health check on port ${PORT})`);

  // Self-ping every 14 minutes to prevent Render free tier from sleeping
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    setInterval(() => {
      https.get(RENDER_URL, () => {}).on("error", () => {});
    }, 14 * 60 * 1000);
    console.log("🏓 Self-ping enabled — bot will stay awake");
  }
});
