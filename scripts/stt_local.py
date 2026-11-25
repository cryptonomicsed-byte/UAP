#!/opt/ares/UAP/.venv-stt/bin/python3
"""Real offline STT via Vosk (Apache-2.0, small English model, ~40MB), called with a
16kHz mono PCM WAV path. Prints the transcript as one line of plain text (no JSON wrapper --
the Node caller treats stdout verbatim as the transcript).
"""
import sys
import json
import wave
import vosk

MODEL_PATH = "/opt/ares/UAP/data/vosk-model"

if len(sys.argv) != 2:
    print("", end="")
    sys.exit(1)

vosk.SetLogLevel(-1)
model = vosk.Model(MODEL_PATH)
wf = wave.open(sys.argv[1], "rb")
rec = vosk.KaldiRecognizer(model, wf.getframerate())
while True:
    data = wf.readframes(4000)
    if len(data) == 0:
        break
    rec.AcceptWaveform(data)
result = json.loads(rec.FinalResult())
print(result.get("text", ""))
