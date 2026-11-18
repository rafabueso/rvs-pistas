"""Motor falso para la prueba: imita las respuestas del descargador sin tocar internet."""
import json, os, sys, time

def emit(**kw): print(json.dumps(kw, ensure_ascii=False), flush=True)

args = sys.argv[2:]  # argv[1] es dl_entry.py
cmd = args[0]
get = lambda k: args[args.index(k) + 1]
if cmd == "probe":
    emit(event="result", data={"url": get("--url"), "id": "dQw4w9WgXcQ", "title": "Canción de prueba", "artist": "Artista", "durationSec": 215, "thumbnail": None})
elif cmd == "karaoke":
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "engine"))
    from rvs_engine import karaoke
    src, mode = get("--file"), get("--mode")
    assert os.path.isdir(get("--models")) or True
    for i in range(0, 101, 50):
        emit(event="progress", stage="separate", pct=i, message="Quitando la voz"); time.sleep(0.1)
    dst = str(karaoke.output_path(src, mode)); open(dst, "wb").write(b"fake")
    emit(event="result", data={"path": dst, "mode": mode})
else:
    for i in range(0, 101, 25):
        emit(event="progress", stage="download", pct=i, message=""); time.sleep(0.2)
    emit(event="progress", stage="convert", pct=0, message="")
    fmt = get("--format"); path = os.path.join(get("--out"), f"Artista - Canción de prueba.{fmt}")
    open(path, "wb").write(b"fake")
    emit(event="result", data={"path": path, "title": "Canción de prueba", "artist": "Artista", "durationSec": 215})
