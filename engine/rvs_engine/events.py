"""Salida del motor: una línea JSON por evento en stdout (la lee la app)."""
import json
import sys


def emit(event: str, **fields) -> None:
    # ensure_ascii: en Windows la consola puede ir en cp1252 y los acentos llegaban rotos a la app
    sys.stdout.write(json.dumps({"event": event, **fields}, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def progress(stage: str, pct: float, message: str = "") -> None:
    emit("progress", stage=stage, pct=round(max(0.0, min(100.0, pct)), 1), message=message)


class EngineError(Exception):
    """Error con un código estable para que la app muestre un mensaje claro."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
