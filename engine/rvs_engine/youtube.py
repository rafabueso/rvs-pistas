"""Reconocer y descargar el audio de un vídeo de YouTube con yt-dlp."""
import glob
import os
import shutil
from typing import Callable, Optional

from .audio import ffmpeg_path
from .events import EngineError
from .urls import canonical_youtube_url

MAX_SECONDS = 20 * 60  # límite razonable: una canción, no un directo de horas


def _options(extra: Optional[dict] = None) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "allowed_extractors": ["youtube"],
        "socket_timeout": 30,
        "retries": 3,
        "ffmpeg_location": os.path.dirname(ffmpeg_path()),
        "restrictfilenames": True,
        "color": "no_color",
    }
    node = shutil.which("node") or shutil.which("deno")
    if node:  # YouTube necesita un intérprete de JavaScript para algunos vídeos
        opts["js_runtimes"] = {os.path.basename(node).split(".")[0]: {"path": node}}
    if extra:
        opts.update(extra)
    return opts


def _friendly(exc: Exception) -> EngineError:
    text = str(exc).lower()
    if "private" in text or "sign in" in text or "age" in text:
        return EngineError("yt_restricted", "Ese vídeo es privado o tiene restricción de edad.")
    if "unavailable" in text or "not available" in text or "removed" in text:
        return EngineError("yt_unavailable", "Ese vídeo no está disponible.")
    if "network" in text or "urlopen" in text or "timed out" in text or "resolve" in text:
        return EngineError("network", "No hay conexión con YouTube. Comprueba tu internet.")
    return EngineError("yt_failed", "No se ha podido leer el vídeo. Si pasa con todos, hay que actualizar la aplicación.")


def probe(url: str) -> dict:
    """Reconoce el vídeo sin descargarlo: título, canal, duración y miniatura."""
    import yt_dlp

    clean = canonical_youtube_url(url)
    try:
        with yt_dlp.YoutubeDL(_options({"skip_download": True})) as ydl:
            info = ydl.extract_info(clean, download=False)
    except Exception as exc:
        raise _friendly(exc)
    if info.get("is_live"):
        raise EngineError("yt_live", "Los directos no se pueden procesar.")
    duration = int(info.get("duration") or 0)
    if duration > MAX_SECONDS:
        raise EngineError("yt_too_long", "El vídeo dura más de 20 minutos; pega una canción.")
    return {
        "url": clean,
        "id": info.get("id"),
        "title": info.get("track") or info.get("title") or "Sin título",
        "artist": info.get("artist") or info.get("uploader") or "",
        "durationSec": duration,
        "thumbnail": info.get("thumbnail") if str(info.get("thumbnail", "")).startswith("https://i.ytimg.com/") else None,
    }


def download_audio(url: str, out_dir: str, on_progress: Optional[Callable[[float], None]] = None) -> str:
    """Baja el mejor audio a out_dir/source.* y devuelve la ruta."""
    import yt_dlp

    clean = canonical_youtube_url(url)

    def hook(d):
        if on_progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                on_progress(d.get("downloaded_bytes", 0) / total)

    opts = _options({
        "format": "bestaudio/best",
        "outtmpl": os.path.join(out_dir, "source.%(ext)s"),
        "progress_hooks": [hook],
        "match_filter": yt_dlp.utils.match_filter_func(f"duration <= {MAX_SECONDS} & !is_live"),
    })
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([clean])
    except Exception as exc:
        raise _friendly(exc)
    found = sorted(glob.glob(os.path.join(out_dir, "source.*")))
    found = [f for f in found if not f.endswith((".part", ".ytdl"))]
    if not found:
        raise EngineError("yt_failed", "La descarga no ha generado ningún archivo.")
    return found[0]
