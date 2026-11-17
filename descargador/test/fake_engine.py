"""Motor falso para la prueba: imita las respuestas del descargador sin tocar internet."""
import json, os, sys, time

def emit(**kw): print(json.dumps(kw, ensure_ascii=False), flush=True)

args = sys.argv[2:]  # argv[1] es dl_entry.py
cmd = args[0]
get = lambda k: args[args.index(k) + 1]
if cmd == "probe":
    emit(event="result", data={"url": get("--url"), "id": "dQw4w9WgXcQ", "title": "Canción de prueba", "artist": "Artista", "durationSec": 215, "thumbnail": None})
else:
    for i in range(0, 101, 25):
        emit(event="progress", stage="download", pct=i, message=""); time.sleep(0.2)
    emit(event="progress", stage="convert", pct=0, message="")
    fmt = get("--format"); path = os.path.join(get("--out"), f"Artista - Canción de prueba.{fmt}")
    open(path, "wb").write(b"fake")
    emit(event="result", data={"path": path, "title": "Canción de prueba", "artist": "Artista", "durationSec": 215})
