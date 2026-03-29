import sys
import os
import json
import warnings
import traceback

# Suppress all warnings
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
warnings.filterwarnings("ignore")

# Redirect stderr to suppress library warnings
import io
old_stderr = sys.stderr
sys.stderr = io.StringIO()

try:
    from faster_whisper import WhisperModel

    audio_path = sys.argv[1]

    # Try multiple model paths
    model_paths = ["/app/whisper_models", "/tmp/whisper_models", None]
    model = None
    for mp in model_paths:
        try:
            if mp:
                model = WhisperModel("tiny", device="cpu", compute_type="int8", download_root=mp)
            else:
                model = WhisperModel("tiny", device="cpu", compute_type="int8")
            break
        except Exception:
            continue

    if model is None:
        sys.stderr = old_stderr
        print("ERROR: Could not load whisper model", file=sys.stderr)
        sys.exit(1)

    segments, info = model.transcribe(audio_path)

    chunks = []
    for segment in segments:
        chunks.append({
            "text": segment.text.strip(),
            "timestamp": [segment.start, segment.end]
        })

    sys.stderr = old_stderr
    print(json.dumps(chunks))

except Exception as e:
    sys.stderr = old_stderr
    print(f"TRANSCRIBE_ERROR: {str(e)}\n{traceback.format_exc()}", file=sys.stderr)
    sys.exit(1)
