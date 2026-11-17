"""Lectura y escritura de audio con ffmpeg (sin más librerías de audio)."""
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np

from .events import EngineError
from .ffmpeg import ffmpeg_path  # noqa: F401  (se reexporta)

SAMPLE_RATE = 44100
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def decode(path: str) -> np.ndarray:
    """Cualquier archivo de audio o vídeo -> float32 estéreo 44,1 kHz, forma (2, n)."""
    cmd = [
        ffmpeg_path(), "-nostdin", "-v", "error", "-i", path, "-vn",
        "-ac", "2", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW)
    if proc.returncode != 0 or not proc.stdout:
        raise EngineError("decode_failed", "No se ha podido leer el audio de ese archivo.")
    data = np.frombuffer(proc.stdout, dtype="<f4")
    data = data[: (data.size // 2) * 2].reshape(-1, 2).T
    return np.ascontiguousarray(data, dtype=np.float32)


def encode(samples: np.ndarray, out_path: str, fmt: str = "flac", bitrate: str = "320k") -> None:
    """Escribe (2, n) float32 como flac, wav o mp3."""
    if fmt not in ("flac", "wav", "mp3"):
        raise EngineError("bad_format", f"Formato no admitido: {fmt}")
    codec = {"flac": ["-c:a", "flac", "-sample_fmt", "s16"],
             "wav": ["-c:a", "pcm_s16le"],
             "mp3": ["-c:a", "libmp3lame", "-b:a", bitrate]}[fmt]
    pcm = np.clip(samples.T, -1.0, 1.0).astype("<f4").tobytes()
    cmd = [
        ffmpeg_path(), "-nostdin", "-y", "-v", "error",
        "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-i", "pipe:0", *codec, out_path,
    ]
    proc = subprocess.run(cmd, input=pcm, capture_output=True, creationflags=_NO_WINDOW)
    if proc.returncode != 0:
        raise EngineError("encode_failed", "No se ha podido guardar el audio.")


def encode_file(src: str, out_path: str, fmt: str, bitrate: str = "320k") -> None:
    """Convierte un archivo de audio ya existente (para exportar)."""
    if fmt not in ("wav", "mp3", "flac"):
        raise EngineError("bad_format", f"Formato no admitido: {fmt}")
    codec = {"flac": ["-c:a", "flac"], "wav": ["-c:a", "pcm_s16le"],
             "mp3": ["-c:a", "libmp3lame", "-b:a", bitrate]}[fmt]
    cmd = [ffmpeg_path(), "-nostdin", "-y", "-v", "error", "-i", src, "-vn", *codec, out_path]
    proc = subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW)
    if proc.returncode != 0:
        raise EngineError("encode_failed", "No se ha podido guardar el audio.")
