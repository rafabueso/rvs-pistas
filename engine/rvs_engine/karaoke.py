"""Karaoke rápido para el descargador: quita la voz (o deja solo la voz) de un audio ya guardado.

Usa solo el modelo de voz de Pistas (el mismo que separa la música), sin separar coros,
así que es la parte más corta del trabajo completo.
"""
import os
import re
import subprocess
from pathlib import Path
from typing import Callable, Optional

from . import models
from .download import FORMATS
from .events import EngineError
from .ffmpeg import ffmpeg_path

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
MODES = {"karaoke": "karaoke", "voz": "solo voz"}
MAX_SECONDS = 20 * 60
AUDIO_EXT = {".mp3", ".m4a", ".wav", ".flac", ".aac", ".ogg", ".opus", ".mp4", ".mov", ".mkv", ".webm"}
_SUFFIX = re.compile(r" \((?:karaoke|solo voz)\)$", re.I)


def output_path(src: str, mode: str) -> Path:
    """Misma carpeta y mismo nombre, con «(karaoke)» o «(solo voz)»; mp3 salvo que el original sea m4a."""
    if mode not in MODES:
        raise EngineError("bad_mode", "Opción no admitida.")
    p = Path(src)
    ext = ".m4a" if p.suffix.lower() == ".m4a" else ".mp3"
    return p.with_name(f"{_SUFFIX.sub('', p.stem)} ({MODES[mode]}){ext}")


def _encode(samples, dst: str, fmt: str) -> None:
    import numpy as np
    from .audio import SAMPLE_RATE

    args, _ = FORMATS[fmt]
    pcm = np.clip(samples.T, -1.0, 1.0).astype("<f4").tobytes()
    cmd = [ffmpeg_path(), "-nostdin", "-y", "-v", "error", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2",
           "-i", "pipe:0", *args, dst]
    r = subprocess.run(cmd, input=pcm, capture_output=True, creationflags=_NO_WINDOW)
    if r.returncode != 0 or not os.path.isfile(dst):
        raise EngineError("encode_failed", "No se ha podido guardar el audio.")


def run(src: str, mode: str, models_dir: str,
        on_progress: Optional[Callable[[str, float, str], None]] = None) -> dict:
    p = Path(src)
    if mode not in MODES:
        raise EngineError("bad_mode", "Opción no admitida.")
    if p.suffix.lower() not in AUDIO_EXT or not p.is_file():
        raise EngineError("bad_file", "No encuentro ese archivo de audio. ¿Lo has movido o borrado?")
    if _SUFFIX.search(p.stem):
        raise EngineError("already", "Ese archivo ya es una versión karaoke o solo voz. Usa el original.")
    say = on_progress or (lambda *_: None)

    # numpy y onnxruntime solo se cargan aquí: la descarga normal no los necesita
    from . import audio
    from .mdx import MDXModel

    say("decode", 0, "Leyendo el audio")
    mix = audio.decode(str(p))
    if mix.shape[1] / audio.SAMPLE_RATE > MAX_SECONDS:
        raise EngineError("too_long", "El audio dura más de 20 minutos.")

    spec = models.MODELS["voces"]
    path = models.ensure_model("voces", models_dir, lambda f: say("model", f * 100, "Preparando el modelo (solo la primera vez)"))
    model = MDXModel(path, spec["n_fft"], spec["dim_f"], spec["dim_t"], spec["compensate"])
    voice = model.separate(mix, on_progress=lambda f: say("separate", f * 100, "Quitando la voz" if mode == "karaoke" else "Sacando la voz")) * spec["compensate"]
    result = (mix - voice) if mode == "karaoke" else voice

    say("save", 100, "Guardando")
    dst = output_path(str(p), mode)
    tmp = dst.with_name(f"{dst.stem}.parte{dst.suffix}")
    try:
        _encode(result, str(tmp), "m4a" if dst.suffix == ".m4a" else "mp3")
        os.replace(tmp, dst)
    finally:
        if tmp.exists():
            tmp.unlink()
    return {"path": str(dst), "mode": mode}
