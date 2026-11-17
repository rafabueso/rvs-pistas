"""Línea de órdenes del motor. La app la llama con una lista de argumentos (nunca por shell)."""
import argparse
import json
import sys
import traceback

from . import __version__, audio, models, pipeline, youtube
from .events import EngineError, emit


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="rvs-engine")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("probe"); s.add_argument("--url", required=True)
    s = sub.add_parser("process")
    s.add_argument("--out", required=True); s.add_argument("--models", required=True)
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--url"); g.add_argument("--file")
    s.add_argument("--title")
    s = sub.add_parser("encode")
    s.add_argument("--in", dest="src", required=True); s.add_argument("--out", required=True)
    s.add_argument("--format", choices=["wav", "mp3", "flac"], required=True)
    s = sub.add_parser("selftest"); s.add_argument("--models", required=True)
    args = p.parse_args(argv)

    try:
        if args.cmd == "probe":
            emit("result", data=youtube.probe(args.url))
        elif args.cmd == "process":
            emit("result", data=pipeline.run(args.out, args.models, url=args.url, file=args.file, title=args.title))
        elif args.cmd == "encode":
            audio.encode_file(args.src, args.out, args.format)
            emit("result", data={"path": args.out})
        elif args.cmd == "selftest":
            import numpy, onnxruntime, yt_dlp

            status = {"version": __version__, "ffmpeg": audio.ffmpeg_path(),
                      "onnxruntime": onnxruntime.__version__, "numpy": numpy.__version__,
                      "yt_dlp": yt_dlp.version.__version__, "models": {}}
            from pathlib import Path
            for key, spec in models.MODELS.items():
                status["models"][key] = (Path(args.models) / spec["file"]).is_file()
            emit("result", data=status)
        return 0
    except EngineError as exc:
        emit("error", code=exc.code, message=exc.message)
        return 2
    except Exception as exc:  # fallo inesperado: mensaje claro y detalle técnico aparte
        emit("error", code="unexpected", message="Ha ocurrido un error inesperado.",
             detail="".join(traceback.format_exception_only(type(exc), exc)).strip()[:500])
        sys.stderr.write(traceback.format_exc())
        return 1
