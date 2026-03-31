FROM node:20-slim

# Make node findable by yt-dlp's JS challenge solver
RUN ln -sf /usr/local/bin/node /usr/bin/node 2>/dev/null || true

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip curl && \
    pip3 install --break-system-packages --no-cache-dir faster-whisper huggingface_hub yt-dlp && \
    ln -sf /usr/local/bin/yt-dlp /usr/bin/yt-dlp && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Verify node is accessible for yt-dlp JS challenge
RUN which node && node --version && echo "Node available for yt-dlp JSC"

# Pre-download whisper tiny model during build so it's cached
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8', download_root='/app/whisper_models')"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
