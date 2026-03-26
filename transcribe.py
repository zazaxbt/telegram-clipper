import sys
import json
import whisper

audio_path = sys.argv[1]
model = whisper.load_model("tiny")
result = model.transcribe(audio_path, word_timestamps=False)

chunks = []
for segment in result["segments"]:
    chunks.append({
        "text": segment["text"].strip(),
        "timestamp": [segment["start"], segment["end"]]
    })

print(json.dumps(chunks))
