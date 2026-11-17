"""Descarga el audio de un vídeo de YouTube y lo deja en MP3 o M4A."""
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Optional

from .events import EngineError
from .ffmpeg import ffmpeg_path
from .youtube import download_audio, probe

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
FORMATS = {
    "mp3": (["-c:a", "libmp3lame", "-q:a", "2"], ".mp3"),
    "m4a": (["-c:a", "aac", "-b:a", "192k"], ".m4a"),
}


def safe_name(title: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", title or "")
    name = re.sub(r"\s+", " ", name).strip(" .")[:80]
    return name or "audio"


def unique_path(folder: Path, base: str, ext: str) -> Path:
    candidate = folder / f"{base}{ext}"
    n = 2
    while candidate.exists():
        candidate = folder / f"{base} ({n}){ext}"
        n += 1
    return candidate


def convert(src: str, dst: str, fmt: str) -> None:
    if fmt not in FORMATS:
        raise EngineError("bad_format", "Formato no admitido.")
    args, _ = FORMATS[fmt]
    cmd = [ffmpeg_path(), "-nostdin", "-y", "-v", "error", "-i", src, "-vn", *args, dst]
    r = subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW)
    if r.returncode != 0 or not os.path.isfile(dst):
        raise EngineError("encode_failed", "No se ha podido convertir el audio.")


def run(url: str, out_dir: str, fmt: str, on_progress: Optional[Callable[[str, float], None]] = None) -> dict:
    if fmt not in FORMATS:
        raise EngineError("bad_format", "Formato no admitido.")
    folder = Path(out_dir)
    if not folder.is_dir():
        raise EngineError("bad_folder", "La carpeta de destino no existe.")
    info = probe(url)
    with tempfile.TemporaryDirectory(prefix="rvsdl-") as tmp:
        src = download_audio(info["url"], tmp, (lambda p: on_progress("download", p)) if on_progress else None)
        if on_progress:
            on_progress("convert", 0.0)
        label = f'{info["artist"]} - {info["title"]}' if info["artist"] and info["artist"] not in info["title"] else info["title"]
        final = unique_path(folder, safe_name(label), FORMATS[fmt][1])
        convert(src, str(final), fmt)
    return {"path": str(final), "title": info["title"], "artist": info["artist"], "durationSec": info["durationSec"]}
