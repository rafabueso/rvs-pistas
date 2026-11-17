"""Localiza el ffmpeg que va dentro de la aplicación."""
import os
import shutil
from pathlib import Path

from .events import EngineError


def ffmpeg_path() -> str:
    env = os.environ.get("RVS_FFMPEG")
    if env and Path(env).is_file():
        return env
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # pragma: no cover - solo si falta el paquete
        found = shutil.which("ffmpeg")
        if found:
            return found
    raise EngineError("no_ffmpeg", "No se encuentra ffmpeg dentro de la aplicación.")
