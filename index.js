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

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
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

// Track user sessions
const sessions = {};

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🎬 *Telegram Clipper Bot*\n\n` +
      `Send me a video (upload or URL) and I'll find the best clips automatically!\n\n` +
      `*Commands:*\n` +
      `/clip - Auto-detect and cut best clips\n` +
      `/cut HH:MM:SS HH:MM:SS - Manual cut with start & end time\n` +
      `/clips N - Set number of auto clips (default: 3)\n` +
      `/duration N - Set max clip duration in seconds (default: 30)`,
    { parse_mode: "Markdown" }
  );
});

// Handle video uploads
bot.on("video", async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.video.file_id;

  try {
    bot.sendMessage(chatId, "⬇️ Downloading video...");
    const filePath = await downloadTelegramFile(fileId, msg);
    sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
    bot.sendMessage(
      chatId,
      "✅ Video received! Send /clip to auto-detect best moments, or /cut HH:MM:SS HH:MM:SS for manual cut."
    );
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Handle document videos (when sent as file)
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const mime = msg.document.mime_type || "";
  if (!mime.startsWith("video/")) return;

  try {
    bot.sendMessage(chatId, "⬇️ Downloading video...");
    const filePath = await downloadTelegramFile(msg.document.file_id, msg);
    sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
    bot.sendMessage(
      chatId,
      "✅ Video received! Send /clip to auto-detect best moments, or /cut HH:MM:SS HH:MM:SS for manual cut."
    );
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Handle direct video URLs
bot.onText(/^(https?:\/\/\S+\.(mp4|mkv|avi|mov|webm)(\?\S*)?)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1];

  try {
    bot.sendMessage(chatId, "⬇️ Downloading video from URL...");
    const filePath = await downloadFromUrl(url, chatId);
    sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
    bot.sendMessage(
      chatId,
      "✅ Video downloaded! Send /clip to auto-detect best moments, or /cut HH:MM:SS HH:MM:SS for manual cut."
    );
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Handle YouTube, Twitter/X, Instagram, TikTok, and other social media URLs
const socialPattern = /^(https?:\/\/\S*(youtube\.com|youtu\.be|twitter\.com|x\.com|instagram\.com|tiktok\.com|facebook\.com|fb\.watch|vimeo\.com|reddit\.com|twitch\.tv)\S*)$/i;
bot.onText(socialPattern, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1];

  try {
    bot.sendMessage(chatId, "⬇️ Downloading video from social media...");
    const filePath = await downloadWithYtdlp(url, chatId);
    sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
    bot.sendMessage(
      chatId,
      "✅ Video downloaded! Send /clip to auto-detect best moments, or /cut HH:MM:SS HH:MM:SS for manual cut."
    );
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Set number of clips
bot.onText(/\/clips\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!sessions[chatId]) return bot.sendMessage(chatId, "Send a video first.");
  sessions[chatId].clipCount = parseInt(match[1]);
  bot.sendMessage(chatId, `✅ Will generate ${match[1]} clips.`);
});

// Set clip duration
bot.onText(/\/duration\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!sessions[chatId]) return bot.sendMessage(chatId, "Send a video first.");
  sessions[chatId].clipDuration = parseInt(match[1]);
  bot.sendMessage(chatId, `✅ Max clip duration set to ${match[1]}s.`);
});

// Auto clip
bot.onText(/\/clip$/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.videoPath) {
    return bot.sendMessage(chatId, "Send a video first.");
  }

  try {
    bot.sendMessage(chatId, "🔍 Analyzing video for interesting moments...");

    const scenes = await detectScenes(session.videoPath);
    const audioPeaks = await detectAudioPeaks(session.videoPath);
    const duration = await getVideoDuration(session.videoPath);

    // Merge scene changes and audio peaks into scored segments
    const highlights = scoreSegments(scenes, audioPeaks, duration, session.clipCount, session.clipDuration);

    if (highlights.length === 0) {
      return bot.sendMessage(chatId, "Couldn't detect interesting moments. Try /cut manually.");
    }

    bot.sendMessage(chatId, `✂️ Found ${highlights.length} highlight(s). Cutting clips...`);

    for (let i = 0; i < highlights.length; i++) {
      const { start, end } = highlights[i];
      const outPath = path.join(TEMP_DIR, `clip_${chatId}_${i}.mp4`);

      await cutVideo(session.videoPath, start, end, outPath);

      const startStr = formatTime(start);
      const endStr = formatTime(end);
      await bot.sendVideo(chatId, outPath, {
        caption: `🎬 Clip ${i + 1}/${highlights.length} (${startStr} → ${endStr})`,
      });

      fs.unlinkSync(outPath);
    }

    bot.sendMessage(chatId, "✅ All clips sent!");
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// Manual cut
bot.onText(/\/cut\s+(\S+)\s+(\S+)/, async (msg, match) => {
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
    await bot.sendVideo(chatId, outPath, {
      caption: `🎬 Clip (${formatTime(start)} → ${formatTime(end)})`,
    });
    fs.unlinkSync(outPath);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// --- Core Functions ---

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

async function downloadWithYtdlp(url, chatId) {
  const dest = path.join(TEMP_DIR, `${Date.now()}_${chatId}.mp4`);
  await youtubedl(url, {
    output: dest,
    format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    mergeOutputFormat: "mp4",
    noCheckCertificates: true,
    noWarnings: true,
  });

  if (!fs.existsSync(dest)) {
    throw new Error("yt-dlp download failed");
  }
  return dest;
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
    const args = [
      "-i", filePath,
      "-vf", "select='gt(scene,0.3)',showinfo",
      "-vsync", "vfr",
      "-f", "null",
      "-"
    ];

    const { spawn } = require("child_process");
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", () => {
      const regex = /pts_time:(\d+\.?\d*)/g;
      let match;
      while ((match = regex.exec(stderr)) !== null) {
        scenes.push(parseFloat(match[1]));
      }
      resolve(scenes);
    });

    proc.on("error", reject);
  });
}

function detectAudioPeaks(filePath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    // Get volume levels per second
    const args = [
      "-i", filePath,
      "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null",
      "-"
    ];

    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", () => {
      const peaks = [];
      const lines = stdout.split("\n");
      let frameTime = 0;

      for (const line of lines) {
        const timeMatch = line.match(/pts_time:(\d+\.?\d*)/);
        if (timeMatch) frameTime = parseFloat(timeMatch[1]);

        const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
        if (rmsMatch) {
          const rms = parseFloat(rmsMatch[1]);
          if (rms > -30) { // Louder than -30dB = interesting
            peaks.push({ time: frameTime, level: rms });
          }
        }
      }

      // Sort by loudness, take top moments
      peaks.sort((a, b) => b.level - a.level);
      resolve(peaks);
    });

    proc.on("error", reject);
  });
}

function scoreSegments(scenes, audioPeaks, totalDuration, clipCount, clipDuration) {
  const segments = [];

  // Create candidate segments around scene changes
  for (const sceneTime of scenes) {
    const start = Math.max(0, sceneTime - 2);
    const end = Math.min(totalDuration, sceneTime + clipDuration);
    let score = 1;

    // Boost score if audio peaks are nearby
    for (const peak of audioPeaks) {
      if (peak.time >= start && peak.time <= end) {
        score += (peak.level + 50) / 10; // Normalize score
      }
    }

    segments.push({ start, end, score });
  }

  // Also add segments around top audio peaks
  for (const peak of audioPeaks.slice(0, 10)) {
    const start = Math.max(0, peak.time - 5);
    const end = Math.min(totalDuration, peak.time + clipDuration - 5);
    const score = (peak.level + 50) / 5;
    segments.push({ start, end, score });
  }

  // If no highlights found, split video into equal parts
  if (segments.length === 0) {
    const segLen = totalDuration / clipCount;
    for (let i = 0; i < clipCount; i++) {
      const start = i * segLen;
      const end = Math.min(start + clipDuration, totalDuration);
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
    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(end - start)
      .output(outputPath)
      .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-preset", "fast"])
      .on("end", resolve)
      .on("error", reject)
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

// Health endpoint for Render free tier
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Telegram Clipper Bot is running");
}).listen(PORT, () => {
  console.log(`🎬 Telegram Clipper Bot is running! (health check on port ${PORT})`);
});
