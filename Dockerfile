FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip curl && \
    pip3 install --break-system-packages --no-cache-dir faster-whisper huggingface_hub yt-dlp && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Make node findable everywhere — yt-dlp needs it for YouTube JS challenge
RUN ln -sf $(which node) /usr/bin/node 2>/dev/null || true && \
    ln -sf $(which node) /usr/local/bin/node 2>/dev/null || true && \
    ln -sf $(which node) /usr/bin/nodejs 2>/dev/null || true && \
    echo "Node at: $(which node) version: $(node --version)"

# Verify yt-dlp can find node
RUN python3 -c "import shutil; print('yt-dlp will find node at:', shutil.which('node'))"

# Pre-download whisper tiny model during build so it's cached
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8', download_root='/app/whisper_models')"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
