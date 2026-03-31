FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip curl unzip fontconfig && \
    pip3 install --break-system-packages --no-cache-dir faster-whisper huggingface_hub yt-dlp && \
    mkdir -p /usr/share/fonts/truetype/montserrat && \
    curl -fsSL -o /tmp/montserrat.zip "https://fonts.google.com/download?family=Montserrat" && \
    unzip -o /tmp/montserrat.zip -d /usr/share/fonts/truetype/montserrat/ && \
    rm /tmp/montserrat.zip && \
    fc-cache -fv && \
    apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Install deno — yt-dlp needs a JS runtime for YouTube's JS challenge
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip && \
    unzip -o /tmp/deno.zip -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/deno && \
    rm /tmp/deno.zip && \
    echo "Deno installed: $(deno --version | head -1)"

# Make node also findable
RUN ln -sf $(which node) /usr/bin/node 2>/dev/null || true

# Verify JS runtimes are accessible
RUN python3 -c "import shutil; print('node:', shutil.which('node')); print('deno:', shutil.which('deno'))"

# Pre-download whisper tiny model during build so it's cached
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8', download_root='/app/whisper_models')"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
