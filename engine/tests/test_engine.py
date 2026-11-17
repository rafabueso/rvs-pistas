import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from rvs_engine import analysis, audio, mdx, pipeline  # noqa: E402
from rvs_engine.events import EngineError  # noqa: E402
from rvs_engine.urls import canonical_youtube_url  # noqa: E402
import synth  # noqa: E402

MODELS = os.environ.get("RVS_MODELS", "")


class Urls(unittest.TestCase):
    def test_acepta_formas_habituales(self):
        want = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        for u in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?si=abc",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30s",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ",
        ]:
            self.assertEqual(canonical_youtube_url(u), want, u)

    def test_rechaza_lo_demas(self):
        for u in [
            "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://evil.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/playlist?list=PL123",
            "https://www.youtube.com/watch?v=corto",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ;rm -rf /",
            "file:///etc/passwd", "javascript:alert(1)", "", "https://youtu.be/",
            "https://user@www.youtube.com@evil.com/watch?v=dQw4w9WgXcQ",
        ]:
            with self.assertRaises(EngineError, msg=u):
                canonical_youtube_url(u)


class Analisis(unittest.TestCase):
    def test_bpm(self):
        for bpm in (90, 120, 128):
            x, _ = synth.song(40, bpm)
            got = analysis.estimate_bpm(x)
            self.assertLess(abs(got - bpm), 2.0, f"esperado {bpm}, obtenido {got}")

    def test_tonalidad(self):
        x, _ = synth.song(40, 100)
        key = analysis.estimate_key(x)
        self.assertEqual((key["tonic"], key["mode"]), (9, "menor"), key)


class Audio(unittest.TestCase):
    def test_ida_y_vuelta(self):
        x, _ = synth.song(3)
        with tempfile.TemporaryDirectory() as d:
            for fmt in ("flac", "wav", "mp3"):
                p = os.path.join(d, f"a.{fmt}")
                audio.encode(x, p, fmt)
                y = audio.decode(p)
                self.assertEqual(y.shape[0], 2)
                n = min(x.shape[1], y.shape[1])
                tol = 0.05 if fmt == "mp3" else 0.002
                if fmt == "mp3":  # el mp3 añade retardo: se compara la energía
                    self.assertAlmostEqual(float(np.sqrt((y ** 2).mean())), float(np.sqrt((x ** 2).mean())), delta=0.05)
                else:
                    self.assertLess(float(np.abs(x[:, :n] - y[:, :n]).max()), tol, fmt)

    def test_archivo_no_audio(self):
        with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
            f.write(b"esto no es audio")
            f.flush()
            with self.assertRaises(EngineError):
                audio.decode(f.name)


@unittest.skipUnless(MODELS and (Path(MODELS) / "UVR-MDX-NET-Voc_FT.onnx").is_file(), "faltan los modelos (RVS_MODELS)")
class Separacion(unittest.TestCase):
    def test_flujo_completo(self):
        x, parts = synth.song(14, 120)
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "cancion.wav")
            audio.encode(x, src, "wav")
            events = []
            out = os.path.join(d, "proyecto")
            project = pipeline.run(out, MODELS, file=src, title="Prueba")
            self.assertEqual(set(project["stems"]), {"voz", "coros", "musica"})
            stems = {k: audio.decode(os.path.join(out, v)) for k, v in project["stems"].items()}
            n = min(s.shape[1] for s in stems.values())
            for k, s in stems.items():
                self.assertTrue(np.isfinite(s).all(), k)
                self.assertGreater(float(np.abs(s).max()), 0.001, f"{k} está en silencio")
            recon = sum(s[:, :n] for s in stems.values())
            mix = audio.decode(src)[:, :n]
            err = float(np.sqrt(((recon - mix) ** 2).mean()) / np.sqrt((mix ** 2).mean()))
            self.assertLess(err, 0.05, f"las tres pistas deberían sumar la mezcla original (error {err:.3f})")
            self.assertTrue((Path(out) / "project.json").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
