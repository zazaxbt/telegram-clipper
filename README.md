<div align="center">

# Telegram Clipper

**AI-powered video clipping, editing, and processing bot for Telegram**

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](#tech-stack)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-Processing-007808?logo=ffmpeg&logoColor=white)](#video-processing)
[![Whisper](https://img.shields.io/badge/Whisper-AI_Transcription-74aa9c?logo=openai&logoColor=white)](#ai-features)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](#deployment)
[![License](https://img.shields.io/badge/License-ISC-blue)](#license)

Send a video or YouTube link. Get back perfectly clipped, edited, captioned content — all inside Telegram.

</div>

---

## Overview

Telegram Clipper is a production-grade Telegram bot that turns raw video into polished content. It combines FFmpeg video processing, Whisper AI transcription, intelligent scene detection, and multi-platform downloads into a single conversational interface with **39 commands**.

Send any video (direct upload, YouTube, Twitter, TikTok, Instagram, or 10+ other platforms) and the bot handles downloading, processing, clipping, editing, captioning, and delivery — including files up to **2GB** via GramJS.

---

## Features

### AI-Powered Clipping

| Command | Description |
|---------|-------------|
| `/clip` | Auto-detect best moments using scene detection + audio peak analysis |
| `/qaclip` | Find Q&A moments via Whisper transcription and question pattern matching |
| `/caption` | Generate word-by-word animated captions (CapCut-style with colored accent boxes) |
| `/cut START END` | Manual precision cut with timestamp support (HH:MM:SS, MM:SS, seconds) |

**How clip detection works:**
1. Scene change detection via FFmpeg (`select='gt(scene,0.3)'`)
2. Audio peak analysis (8kHz RMS with -30dB threshold)
3. Combined scoring weighted by loudness and scene proximity
4. Overlap prevention and graceful fallback to equal-split

### Video Editing Suite (30+ Effects)

<details>
<summary><strong>Speed & Time</strong></summary>

| Command | Description |
|---------|-------------|
| `/speed 0.5` | Slow motion (0.1x - 10x) |
| `/speedramp` | Cinematic slow-fast-slow ramp |
| `/reverse` | Play backwards |
| `/boomerang` | Forward-reverse loop |
| `/loop 3` | Loop N times (max 10) |

</details>

<details>
<summary><strong>Visual Effects</strong></summary>

| Command | Description |
|---------|-------------|
| `/filter grayscale` | 10 filters: grayscale, sepia, bright, dark, contrast, blur, sharpen, mirror, flip, negative |
| `/colorgrade cinematic` | 7 grades: cinematic, warm, cool, vintage, dramatic, pastel, noir |
| `/fade 1.5` | Fade in/out effect |
| `/zoom in` | Smooth zoompan effect |
| `/stabilize` | 2-pass video stabilization (vidstab) |
| `/bgremove green` | Chroma key removal (green, blue, white, red) |

</details>

<details>
<summary><strong>Audio</strong></summary>

| Command | Description |
|---------|-------------|
| `/mute` | Remove audio track |
| `/audio` | Extract as MP3 |
| `/volume 1.5` | Adjust volume level |
| `/voice deep` | 7 effects: deep, high, echo, reverb, robot, whisper, telephone |
| `/music` | Add background music overlay |
| `/musiclib chill` | Browse royalty-free library (10 moods) |

</details>

<details>
<summary><strong>Composition</strong></summary>

| Command | Description |
|---------|-------------|
| `/crop 9:16` | Aspect ratio crop (9:16, 1:1, 16:9, 4:5, etc.) |
| `/resize 1280x720` | Resize with aspect preservation |
| `/pip topright` | Picture-in-picture with 2nd video |
| `/split horizontal` | Side-by-side split screen |
| `/text Hello World` | Text overlay with Montserrat font |
| `/merge` | Concatenate multiple videos |
| `/broll sunset` | Auto-insert stock B-roll from Pexels |
| `/autozoom` | Dynamic zoom on audio peaks |

</details>

<details>
<summary><strong>Export</strong></summary>

| Command | Description |
|---------|-------------|
| `/gif` | Convert to GIF (max 15s, optimized) |
| `/compress` | H.264 re-encode for smaller file size |
| `/thumbnail 5.0` | Extract frame at timestamp |

</details>

### Multi-Platform Downloads

Downloads from **10+ platforms** with a 3-tier fallback system:

```
YouTube.js (InnerTube API)  →  Cobalt API  →  yt-dlp (CLI)
       ↑                           ↑              ↑
  Native JS client          3 public instances   3 player clients
  Format selection           Redirect handling    Cookies support
  Adaptive streams           30s timeout          JS solver (Deno/Node)
```

**Supported platforms:**
YouTube, Twitter/X, Instagram, TikTok, Facebook, Vimeo, Reddit, Twitch, Google Drive, and any direct video URL (.mp4, .mkv, .avi, .mov, .webm)

### Large File Handling

Smart delivery system for files up to **2GB**:

```
File ready → Bot API (<45MB) → Success
                ↓ (too large)
             GramJS (up to 2GB, 4 workers) → Success
                ↓ (failed)
             Compress (CRF 30 → CRF 35 + 720p) → Bot API retry
```

### AI Transcription Pipeline

- **Whisper** (faster-whisper, tiny model) for speech-to-text
- Word-level timestamps for precise caption alignment
- 5-minute chunked processing to avoid OOM on long videos
- Auto-generated **CapCut-style captions** with:
  - Word-by-word animation timing
  - 6-color rotating accent palette
  - Colored background boxes (ASS subtitle format)
  - Montserrat Bold @ 90pt, 1080p render resolution

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Runtime** | Node.js 20 |
| **Video Processing** | FFmpeg via fluent-ffmpeg |
| **AI/ML** | faster-whisper (Python3) |
| **Telegram** | node-telegram-bot-api + GramJS |
| **YouTube** | youtubei.js (InnerTube), yt-dlp (fallback) |
| **Stock Footage** | Pexels API |
| **Music** | Pixabay API + yt-dlp search |
| **Container** | Docker (node:20-slim + FFmpeg + Python3 + Whisper + Deno) |

---

## Deployment

### Docker (Recommended)

```bash
docker build -t telegram-clipper .
docker run -d --env-file .env telegram-clipper
```

### Manual

```bash
# Prerequisites: Node.js 20+, FFmpeg, Python3, faster-whisper, yt-dlp
npm install
node index.js
```

### Environment Variables

```env
# Required
TELEGRAM_BOT_TOKEN=your_bot_token

# Optional — enables large file uploads (>50MB)
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_SESSION=saved_session_string

# Optional — stock footage
PEXELS_API_KEY=your_pexels_key

# Optional — access control
BOT_MODE=PRIVATE
BOT_ACCESS_CODE=your_access_code
ADMIN_IDS=comma,separated,ids
ADMIN_KEY=dashboard_password

# Optional — Render.com keep-alive
RENDER_EXTERNAL_URL=https://your-app.onrender.com
```

---

## Architecture

```
User sends video/URL
    │
    ├── URL detected? → 3-tier download (YouTube.js → Cobalt → yt-dlp)
    │
    ├── Video file received → Store locally
    │   └── >50MB? → GramJS download (up to 2GB)
    │
    ├── Command dispatched
    │   ├── /clip     → Scene detection + audio peaks → Smart selection → FFmpeg extract
    │   ├── /qaclip   → Whisper transcribe → Question detection → Clip extraction
    │   ├── /caption  → Whisper word-level → ASS subtitle gen → FFmpeg burn-in
    │   ├── /edit cmd → FFmpeg filter chain → Process → Output
    │   └── /broll    → Pexels search → Download → Segment + insert → Concat
    │
    └── Output delivery
        └── Smart sender (Bot API → GramJS → Compress → Retry)
```

---

## Admin Dashboard

Web-based admin panel at `/dashboard?key=ADMIN_KEY`:
- Real-time stats (users, clips generated, edits processed)
- User authorization management
- Activity tracking with last-active timestamps

---

## License

ISC
