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

// Whisper transcription via Python (lightweight, runs on demand)

// Track user sessions
const sessions = {};

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🎬 *Telegram Clipper Bot*\n\n` +
      `Send me a video (upload or URL) and I'll find the best clips automatically!\n\n` +
      `*Commands:*\n` +
      `/clip - Auto-detect and cut best clips\n` +
      `/clip 60 - Auto-clip with custom duration\n` +
      `/qaclip - Find Q&A moments and clip answers with question as caption\n` +
      `/cut HH:MM:SS HH:MM:SS - Manual cut with start & end time\n` +
      `/clips N - Set number of auto clips (default: 3)\n` +
      `/duration N - Set max clip duration in seconds (default: 30)\n\n` +
      `Also supports YouTube, Twitter/X, Instagram, TikTok links!`,
    { parse_mode: "Markdown" }
  );
});

const COMMANDS_TEXT = "📋 Commands:\n/clip - Auto-detect best moments\n/clip 60 - Custom clip duration\n/qaclip - Find Q&A moments\n/cut 00:01:30 00:02:45 - Manual cut\n/clips 5 - Set number of clips\n/duration 60 - Set max duration";

// Handle video uploads
bot.on("video", async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.video.file_id;
  const fileSize = msg.video.file_size || 0;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

  try {
    const dlMsg = await bot.sendMessage(chatId, `⬇️ Downloading video (${sizeMB} MB)...`);
    const startTime = Date.now();
    const filePath = await downloadTelegramFile(fileId, msg);
    const dlTime = ((Date.now() - startTime) / 1000).toFixed(1);
    await updateProgress(chatId, dlMsg.message_id, `✅ Video received! (${sizeMB} MB in ${dlTime}s)\n\n${COMMANDS_TEXT}`);
    sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Handle document videos (when sent as file)
bot.on("document", async (msg) => {
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
    sessions[chatId] = { videoPath: filePath, clipCount: 3, clipDuration: 30 };
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to download: ${err.message}`);
  }
});

// Handle direct video URLs
bot.onText(/^(https?:\/\/\S+\.(mp4|mkv|avi|mov|webm)(\?\S*)?)$/i, async (msg, match) => {
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
bot.onText(/^\/clips\s+(\d+)/, (msg, match) => {
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
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.videoPath) {
    return bot.sendMessage(chatId, "Send a video first.");
  }
  if (match[1]) session.clipDuration = parseInt(match[1]);

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

    for (let i = 0; i < highlights.length; i++) {
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

      await bot.sendVideo(chatId, outPath, {
        caption: `🎬 Clip ${i + 1}/${highlights.length} (${formatTime(start)} → ${formatTime(end)}, ${clipDur}s)`,
      });

      fs.unlinkSync(outPath);
    }

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
  }
});

// Q&A clip — transcribe, find questions, clip answers with question as caption
bot.onText(/\/qaclip(?:\s+(\d+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !session.videoPath) {
    return bot.sendMessage(chatId, "Send a video first.");
  }

  const clipDuration = match[1] ? parseInt(match[1]) : session.clipDuration;

  try {
    const videoDuration = await getVideoDuration(session.videoPath);
    const estMinutes = Math.ceil(videoDuration / 60);
    bot.sendMessage(chatId, `🎙️ Transcribing video (~${estMinutes} min video)...\n⏳ Estimated time: ${estMinutes}-${estMinutes * 2} minutes`);

    // Extract audio as WAV for Whisper
    bot.sendMessage(chatId, "📊 Step 1/3: Extracting audio...");
    const wavPath = path.join(TEMP_DIR, `audio_${chatId}.wav`);
    await extractAudio(session.videoPath, wavPath);

    // Transcribe with timestamps using Python whisper
    bot.sendMessage(chatId, "📊 Step 2/3: Running AI transcription (this is the slow part)...");
    const chunks = await transcribeWithWhisper(wavPath);

    fs.unlinkSync(wavPath);

    // Find questions in the transcript
    bot.sendMessage(chatId, `📊 Step 3/3: Found ${chunks.length} text segments. Searching for Q&A moments...`);
    const qaClips = extractQASegments(chunks, clipDuration);

    if (qaClips.length === 0) {
      return bot.sendMessage(chatId, "No questions detected in the video. Try /clip for auto-highlights instead.");
    }

    bot.sendMessage(chatId, `❓ Found ${qaClips.length} Q&A moment(s). Cutting clips...`);

    for (let i = 0; i < qaClips.length; i++) {
      const { question, start, end } = qaClips[i];
      const outPath = path.join(TEMP_DIR, `qa_${chatId}_${i}.mp4`);

      await cutVideo(session.videoPath, start, end, outPath);

      const caption = `❓ ${question}\n\n🎬 Clip ${i + 1}/${qaClips.length} (${formatTime(start)} → ${formatTime(end)})`;
      await bot.sendVideo(chatId, outPath, {
        caption: caption.slice(0, 1024), // Telegram caption limit
      });

      fs.unlinkSync(outPath);
    }

    bot.sendMessage(chatId, "✅ All Q&A clips sent!");
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

function transcribeWithWhisper(wavPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [path.join(__dirname, "transcribe.py"), wavPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Transcription failed: ${stderr}`));
      try {
        const chunks = JSON.parse(stdout);
        resolve(chunks);
      } catch {
        reject(new Error("Failed to parse transcription output"));
      }
    });

    proc.on("error", reject);
  });
}

function extractAudio(videoPath, wavPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .output(wavPath)
      .outputOptions(["-ar", "16000", "-ac", "1", "-f", "wav"])
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

function extractQASegments(chunks, maxClipDuration) {
  const qaClips = [];

  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i].text.trim();

    // Detect questions
    if (text.includes("?")) {
      const question = text;
      const questionStart = chunks[i].timestamp[0];

      // The answer is everything after the question until the next question or maxClipDuration
      const answerStart = chunks[i].timestamp[1] || chunks[i].timestamp[0];
      let answerEnd = answerStart + maxClipDuration;

      // Collect answer text from following chunks
      for (let j = i + 1; j < chunks.length; j++) {
        const nextText = chunks[j].text.trim();
        const nextEnd = chunks[j].timestamp[1] || chunks[j].timestamp[0];

        // Stop if we hit another question or exceed duration
        if (nextText.includes("?") || nextEnd - questionStart > maxClipDuration) {
          answerEnd = nextEnd;
          break;
        }
        answerEnd = nextEnd;
      }

      // Clip starts a bit before the question for context
      const clipStart = Math.max(0, questionStart - 1);
      const clipEnd = Math.min(answerEnd, clipStart + maxClipDuration);

      qaClips.push({
        question: question,
        start: clipStart,
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
    // Speed up: only analyze 1 frame per second instead of every frame
    const args = [
      "-i", filePath,
      "-vf", "fps=1,select='gt(scene,0.3)',showinfo",
      "-vsync", "vfr",
      "-f", "null",
      "-"
    ];

    const { spawn } = require("child_process");
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";

    // Timeout after 2 minutes
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(scenes); // Return whatever we found so far
    }, 2 * 60 * 1000);

    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", () => {
      clearTimeout(timeout);
      const regex = /pts_time:(\d+\.?\d*)/g;
      let match;
      while ((match = regex.exec(stderr)) !== null) {
        scenes.push(parseFloat(match[1]));
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
    const args = [
      "-i", filePath,
      "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null",
      "-"
    ];

    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    // Timeout after 2 minutes
    const timeout = setTimeout(() => {
      proc.kill();
      resolve([]);
    }, 2 * 60 * 1000);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", () => {
      clearTimeout(timeout);
      const peaks = [];
      const lines = stdout.split("\n");
      let frameTime = 0;

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

// Health endpoint for Render free tier
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Telegram Clipper Bot is running");
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
