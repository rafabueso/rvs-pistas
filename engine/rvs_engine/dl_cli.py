"""Orden de línea para el descargador: solo reconoce y descarga audio."""
import argparse
import sys
import traceback

from . import events
from .events import EngineError


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="rvs-dl")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("probe"); s.add_argument("--url", required=True)
    s = sub.add_parser("download")
    s.add_argument("--url", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--format", default="mp3", choices=["mp3", "m4a"])
    s = sub.add_parser("karaoke")
    s.add_argument("--file", required=True)
    s.add_argument("--mode", required=True, choices=["karaoke", "voz"])
    s.add_argument("--models", required=True)
    a = p.parse_args(argv)
    try:
        if a.cmd == "probe":
            from .youtube import probe
            events.emit("result", data=probe(a.url))
        elif a.cmd == "karaoke":
            from . import karaoke
            events.emit("result", data=karaoke.run(a.file, a.mode, a.models, events.progress))
        else:
            from . import download
            data = download.run(a.url, a.out, a.format,
                                lambda stage, pct: events.progress(stage, pct * 100 if stage == "download" else 0))
            events.emit("result", data=data)
        return 0
    except EngineError as e:
        events.emit("error", code=e.code, message=e.message)
        return 2
    except Exception:  # pragma: no cover
        sys.stderr.write(traceback.format_exc())
        events.emit("error", code="unexpected", message="Ha ocurrido un error inesperado.")
        return 1
