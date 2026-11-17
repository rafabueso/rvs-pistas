"""Validación estricta de enlaces: solo vídeos sueltos de YouTube."""
import re
from urllib.parse import parse_qs, urlparse

from .events import EngineError

_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}


def canonical_youtube_url(raw: str) -> str:
    """Devuelve https://www.youtube.com/watch?v=ID o lanza EngineError.

    Descarta listas de reproducción y cualquier otro parámetro, así que el
    resto del enlace nunca llega al descargador.
    """
    text = (raw or "").strip()
    if len(text) > 300:
        raise EngineError("bad_url", "El enlace es demasiado largo.")
    parsed = urlparse(text)
    if parsed.scheme != "https" or (parsed.hostname or "") not in _HOSTS:
        raise EngineError("bad_url", "Pega un enlace de YouTube que empiece por https://")
    video_id = None
    host = parsed.hostname
    parts = [p for p in parsed.path.split("/") if p]
    if host == "youtu.be" and len(parts) == 1:
        video_id = parts[0]
    elif parts[:1] == ["watch"]:
        video_id = (parse_qs(parsed.query).get("v") or [None])[0]
    elif len(parts) == 2 and parts[0] in ("shorts", "embed", "live"):
        video_id = parts[1]
    if not video_id or not _VIDEO_ID.match(video_id):
        raise EngineError("bad_url", "Ese enlace no es de un vídeo suelto de YouTube.")
    return f"https://www.youtube.com/watch?v={video_id}"
