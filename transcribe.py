import sys
import os
import json
import warnings

# Suppress HuggingFace warnings
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
warnings.filterwarnings("ignore")

from faster_whisper import WhisperModel

audio_path = sys.argv[1]

try:
    model = WhisperModel("tiny", device="cpu", compute_type="int8", download_root="/tmp/whisper_models")
    segments, info = model.transcribe(audio_path)

    chunks = []
    for segment in segments:
        chunks.append({
            "text": segment.text.strip(),
            "timestamp": [segment.start, segment.end]
        })

    print(json.dumps(chunks))
except Exception as e:
    print(json.dumps([]), flush=True)
    sys.exit(1)
