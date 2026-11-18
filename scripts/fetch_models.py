"""Descarga los modelos de separación a build/models comprobando su huella sha256."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "engine"))
from rvs_engine.models import MODELS, ensure_model  # noqa: E402

out = root / "build" / "models"
out.mkdir(parents=True, exist_ok=True)
for key in (sys.argv[1:] or MODELS):
    print("modelo", key, "->", ensure_model(key, str(out)), flush=True)
