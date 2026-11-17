"""Modelos de separación: comprobación de integridad y descarga de reserva."""
import hashlib
import os
import urllib.request
from pathlib import Path
from typing import Callable, Dict, Optional

from .events import EngineError

_BASE = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/"

# Parámetros tomados de la tabla pública de UVR (mdx_model_data). dim_t = 2**8.
MODELS: Dict[str, dict] = {
    # Separa la voz completa (principal + coros) del resto.
    "voces": {
        "file": "UVR-MDX-NET-Voc_FT.onnx",
        "sha256": "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111",
        "n_fft": 7680, "dim_f": 3072, "dim_t": 256, "compensate": 1.021,
    },
    # Sobre la voz sola: lo que devuelve es la voz de fondo (coros); la principal es la resta.
    "coros": {
        "file": "UVR_MDXNET_KARA_2.onnx",
        "sha256": "bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4",
        "n_fft": 5120, "dim_f": 2048, "dim_t": 256, "compensate": 1.065,
    },
}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def model_dirs(extra: Optional[str] = None):
    dirs = []
    if extra:
        dirs.append(Path(extra))
    env = os.environ.get("RVS_MODELS")
    if env:
        dirs.append(Path(env))
    return dirs


def ensure_model(key: str, models_dir: str, on_progress: Optional[Callable[[float], None]] = None) -> str:
    """Devuelve la ruta de un modelo verificado; si falta, lo descarga y verifica."""
    spec = MODELS[key]
    for d in [Path(models_dir), *model_dirs()]:
        candidate = d / spec["file"]
        if candidate.is_file() and _sha256(candidate) == spec["sha256"]:
            return str(candidate)
    target_dir = Path(models_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / spec["file"]
    tmp = target.with_suffix(".part")
    try:
        with urllib.request.urlopen(_BASE + spec["file"], timeout=60) as resp, open(tmp, "wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            while True:
                block = resp.read(1 << 20)
                if not block:
                    break
                out.write(block)
                done += len(block)
                if on_progress and total:
                    on_progress(done / total)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise EngineError("model_download", "Falta un modelo y no se ha podido descargar. Comprueba tu conexión.")
    if _sha256(tmp) != spec["sha256"]:
        tmp.unlink(missing_ok=True)
        raise EngineError("model_corrupt", "El modelo descargado no es el esperado y se ha descartado.")
    tmp.replace(target)
    return str(target)
