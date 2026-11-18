"""Flujo completo: enlace o archivo -> tres pistas (voz, coros, música)."""
import json
import os
import time
import uuid
from pathlib import Path
from typing import Optional

import numpy as np

from . import analysis, audio, models, youtube
from .events import EngineError, progress
from .mdx import MDXModel

AUDIO_EXT = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".mp4", ".mov", ".mkv", ".webm"}


def _load(key: str, models_dir: str, stage: str, lo: float, hi: float, denoise: bool = False) -> MDXModel:
    path = models.ensure_model(key, models_dir, lambda p: progress(stage, lo + (hi - lo) * p, "Preparando el modelo"))
    spec = models.MODELS[key]
    return MDXModel(path, spec["n_fft"], spec["dim_f"], spec["dim_t"], spec["compensate"], denoise=denoise)


def run(out_dir: str, models_dir: str, url: Optional[str] = None, file: Optional[str] = None,
        title: Optional[str] = None) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    meta = {"title": title or "Sin título", "artist": "", "source": "archivo"}

    # 1) Entrada
    if url:
        info = youtube.probe(url)
        meta.update(title=info["title"], artist=info["artist"], source=info["url"])
        progress("download", 1, "Descargando el audio")
        src = youtube.download_audio(url, str(out), lambda p: progress("download", 1 + 14 * p, "Descargando el audio"))
    elif file:
        src_path = Path(file)
        if src_path.suffix.lower() not in AUDIO_EXT or not src_path.is_file():
            raise EngineError("bad_file", "Elige un archivo de audio o vídeo (mp3, wav, flac, m4a, mp4...).")
        meta.update(title=title or src_path.stem, source="archivo")
        src = str(src_path)
    else:
        raise EngineError("bad_input", "Falta el enlace o el archivo.")

    progress("decode", 16, "Leyendo el audio")
    mix = audio.decode(src)
    duration = mix.shape[1] / audio.SAMPLE_RATE
    if duration < 5:
        raise EngineError("too_short", "El audio dura menos de 5 segundos.")
    if duration > youtube.MAX_SECONDS:
        raise EngineError("too_long", "El audio dura más de 20 minutos.")

    # 2) Voz completa y música
    voc_model = _load("voces", models_dir, "separate", 17, 20)
    progress("separate", 20, "Separando la voz de la música")
    vocals = voc_model.separate(mix, on_progress=lambda p: progress("separate", 20 + 45 * p, "Separando la voz de la música"))
    del voc_model
    vocals = vocals * models.MODELS["voces"]["compensate"]
    music = mix - vocals

    # 3) Voz principal y coros
    kara = _load("coros", models_dir, "split", 65, 67)
    progress("split", 67, "Separando coros de voz principal")
    backing = kara.separate(vocals, on_progress=lambda p: progress("split", 67 + 25 * p, "Separando coros de voz principal"))
    backing = backing * models.MODELS["coros"]["compensate"]
    lead = vocals - backing  # voz + coros + música suman exactamente la mezcla original
    del kara

    # 4) Guardar y analizar
    progress("save", 93, "Guardando las pistas")
    stems = {"voz": lead, "coros": backing, "musica": music}
    for name, data in stems.items():
        audio.encode(data, str(out / f"{name}.flac"), "flac")
    progress("analyze", 97, "Calculando tempo y tonalidad")
    bpm = analysis.estimate_bpm(mix)
    key = analysis.estimate_key(mix)

    project = {
        "id": out.name,
        "title": meta["title"], "artist": meta["artist"], "source": meta["source"],
        "durationSec": round(duration, 2), "sampleRate": audio.SAMPLE_RATE,
        "bpm": bpm, "key": key,
        "stems": {k: f"{k}.flac" for k in stems},
        "createdAt": int(time.time()),
    }
    (out / "project.json").write_text(json.dumps(project, ensure_ascii=False, indent=1), encoding="utf-8")
    # el original ya no hace falta: se borra para no acumular archivos pesados
    if url:
        try:
            os.remove(src)
        except OSError:
            pass
    progress("done", 100, "Listo")
    return project


def new_project_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
