import sys
import json
from faster_whisper import WhisperModel

audio_path = sys.argv[1]
model = WhisperModel("tiny", device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio_path, beam_size=1)

chunks = []
for segment in segments:
    chunks.append({
        "text": segment.text.strip(),
        "timestamp": [segment.start, segment.end]
    })

print(json.dumps(chunks))
