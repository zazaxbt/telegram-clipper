import sys
import os
import json
import warnings
import traceback

# Suppress warnings but DON'T redirect stderr
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
warnings.filterwarnings("ignore")

try:
    from faster_whisper import WhisperModel

    audio_path = sys.argv[1]

    # Try multiple model paths
    model = None
    for mp in ["/app/whisper_models", "/tmp/whisper_models"]:
        try:
            model = WhisperModel("tiny", device="cpu", compute_type="int8", download_root=mp)
            break
        except Exception as e:
            print(f"Model load failed at {mp}: {e}", file=sys.stderr)
            continue

    if model is None:
        # Last resort — no download_root
        model = WhisperModel("tiny", device="cpu", compute_type="int8")

    segments, info = model.transcribe(audio_path)

    chunks = []
    for segment in segments:
        chunks.append({
            "text": segment.text.strip(),
            "timestamp": [segment.start, segment.end]
        })

    print(json.dumps(chunks), flush=True)

except Exception as e:
    print(f"TRANSCRIBE_ERROR: {str(e)}", file=sys.stderr)
    print(traceback.format_exc(), file=sys.stderr)
    sys.exit(1)
