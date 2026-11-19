"""Inferencia de modelos MDX-Net (ONNX) solo con numpy y onnxruntime.

Sigue el procedimiento de Ultimate Vocal Remover: STFT -> modelo -> ISTFT por
trozos solapados con ventana de Hann. No usa PyTorch.
"""
import os
import subprocess
import sys
from typing import Callable, Optional

import numpy as np

HOP = 1024


def default_threads() -> int:
    """Hilos para el modelo. En los Mac con chip Apple solo los núcleos rápidos: repartir el
    trabajo también entre los de eficiencia hace que todos esperen al más lento."""
    n = max(1, os.cpu_count() or 2)
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["sysctl", "-n", "hw.perflevel0.physicalcpu"], capture_output=True, text=True, timeout=2)
            fast = int(out.stdout.strip())
            if 1 <= fast <= n:
                return fast
        except Exception:
            pass
    return n


class MDXModel:
    def __init__(self, path: str, n_fft: int, dim_f: int, dim_t: int = 256,
                 compensate: float = 1.0, threads: Optional[int] = None, denoise: bool = False):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads or default_threads()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.n_fft, self.dim_f, self.dim_t, self.compensate = n_fft, dim_f, dim_t, compensate
        self.denoise = denoise
        self.n_bins = n_fft // 2 + 1
        self.trim = n_fft // 2
        self.chunk = HOP * (dim_t - 1)
        n = np.arange(n_fft)
        self.window = (0.5 - 0.5 * np.cos(2 * np.pi * n / n_fft)).astype(np.float32)  # Hann periódica
        frames = dim_t
        self._wsum = np.zeros(n_fft + HOP * (frames - 1), dtype=np.float32)
        for t in range(frames):
            self._wsum[t * HOP:t * HOP + n_fft] += self.window ** 2

    # -- transformadas -------------------------------------------------
    def stft(self, x: np.ndarray) -> np.ndarray:
        """(2, chunk) -> (4, dim_f, dim_t) con orden [L re, L im, R re, R im]."""
        xp = np.pad(x, ((0, 0), (self.trim, self.trim)), mode="reflect")
        frames = np.lib.stride_tricks.sliding_window_view(xp, self.n_fft, axis=1)[:, ::HOP]
        spec = np.fft.rfft(frames * self.window, axis=-1).transpose(0, 2, 1)[:, : self.dim_f]
        return np.stack([spec.real, spec.imag], axis=1).reshape(4, self.dim_f, -1).astype(np.float32)

    def istft(self, spec: np.ndarray) -> np.ndarray:
        """(4, dim_f, dim_t) -> (2, chunk)."""
        t = spec.shape[-1]
        s = spec.reshape(2, 2, self.dim_f, t)
        full = np.zeros((2, self.n_bins, t), dtype=np.complex64)
        full[:, : self.dim_f] = s[:, 0] + 1j * s[:, 1]
        frames = np.fft.irfft(full.transpose(0, 2, 1), n=self.n_fft, axis=-1).astype(np.float32) * self.window
        out = np.zeros((2, self.n_fft + HOP * (t - 1)), dtype=np.float32)
        for i in range(t):
            out[:, i * HOP:i * HOP + self.n_fft] += frames[:, i]
        out /= np.maximum(self._wsum, 1e-8)
        return out[:, self.trim:-self.trim]

    def _run1(self, chunk: np.ndarray) -> np.ndarray:
        spec = self.stft(chunk)
        spec[:, :3, :] = 0.0  # quita los 3 primeros bins, como UVR
        pred = self.session.run(None, {self.input_name: spec[None]})[0][0]
        return self.istft(pred)

    def _run(self, chunk: np.ndarray) -> np.ndarray:
        if not self.denoise:
            return self._run1(chunk)
        # Como el "denoise" de UVR: se separa el trozo y su inverso y se promedian;
        # el ruido propio del modelo se cancela y quedan menos restos de voz.
        return (self._run1(chunk) - self._run1(-chunk)) * 0.5

    # -- separación completa ------------------------------------------
    def separate(self, mix: np.ndarray, overlap: float = 0.25,
                 on_progress: Optional[Callable[[float], None]] = None) -> np.ndarray:
        """mix (2, n) float32 -> pista principal del modelo (2, n)."""
        n = mix.shape[1]
        peak = float(np.abs(mix).max())
        scale = 0.9 / peak if peak > 0.9 else 1.0
        mix = (mix * scale).astype(np.float32)

        gen = self.chunk - 2 * self.trim
        pad = gen + self.trim - (n % gen)
        padded = np.concatenate(
            [np.zeros((2, self.trim), np.float32), mix, np.zeros((2, pad), np.float32)], axis=1)
        step = int((1 - overlap) * self.chunk)
        result = np.zeros_like(padded)
        divider = np.zeros_like(padded)
        starts = list(range(0, padded.shape[1], step))
        for k, start in enumerate(starts):
            end = min(start + self.chunk, padded.shape[1])
            part = padded[:, start:end]
            if part.shape[1] < self.chunk:
                part = np.pad(part, ((0, 0), (0, self.chunk - part.shape[1])))
            out = self._run(part)[:, : end - start]
            window = np.hanning(end - start).astype(np.float32)[None, :]
            result[:, start:end] += out * window
            divider[:, start:end] += window
            if on_progress:
                on_progress((k + 1) / len(starts))
        result /= np.maximum(divider, 1e-8)
        return (result[:, self.trim:self.trim + n] / scale).astype(np.float32)
