"""Tempo (BPM) y tonalidad aproximados, solo con numpy."""
import numpy as np

from .audio import SAMPLE_RATE

NOTES_ES = ["Do", "Do♯", "Re", "Re♯", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "La♯", "Si"]
# Perfiles de Krumhansl-Schmuckler
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _mono(x: np.ndarray, max_seconds: float = 150.0) -> np.ndarray:
    m = x.mean(axis=0)
    limit = int(max_seconds * SAMPLE_RATE)
    if m.size > limit:  # trozo central: suficiente para estimar y mucho más rápido
        start = (m.size - limit) // 2
        m = m[start:start + limit]
    return m.astype(np.float32)


def estimate_bpm(x: np.ndarray) -> float:
    m = _mono(x)
    n_fft, hop = 2048, 512
    if m.size < n_fft * 8:
        return 0.0
    frames = np.lib.stride_tricks.sliding_window_view(m, n_fft)[::hop]
    mag = np.abs(np.fft.rfft(frames * np.hanning(n_fft), axis=1))
    mag = np.log1p(10 * mag[:, 2:400])  # hasta ~8,6 kHz
    flux = np.maximum(mag[1:] - mag[:-1], 0).sum(axis=1)
    flux = flux - np.convolve(flux, np.ones(43) / 43, mode="same")
    flux = np.maximum(flux, 0)
    if flux.std() < 1e-6:
        return 0.0
    fps = SAMPLE_RATE / hop
    size = 1 << int(np.ceil(np.log2(flux.size * 2)))
    spec = np.fft.rfft(flux, size)
    ac = np.fft.irfft(spec * np.conj(spec), size)[: flux.size]
    ac /= ac[0] + 1e-9
    bpms = np.arange(60.0, 200.0, 0.5)
    lags = fps * 60.0 / bpms
    lo, hi = np.floor(lags).astype(int), np.ceil(lags).astype(int)
    frac = lags - lo
    score = ac[lo] * (1 - frac) + ac[np.minimum(hi, ac.size - 1)] * frac
    # contexto: refuerza el doble y la mitad (compases), y prefiere tempos habituales
    half = np.interp(bpms / 2, bpms, score, left=0, right=0)
    double = np.interp(bpms * 2, bpms, score, left=0, right=0)
    prior = np.exp(-0.5 * (np.log2(bpms / 112.0) / 0.9) ** 2)
    total = (score + 0.5 * half + 0.25 * double) * prior
    return float(bpms[int(np.argmax(total))])


def estimate_key(x: np.ndarray) -> dict:
    m = _mono(x)
    n_fft, hop = 8192, 4096
    if m.size < n_fft * 4:
        return {"tonic": 0, "mode": "mayor", "name": "Do mayor", "confidence": 0.0}
    frames = np.lib.stride_tricks.sliding_window_view(m, n_fft)[::hop]
    mag = np.abs(np.fft.rfft(frames * np.hanning(n_fft), axis=1))
    freqs = np.fft.rfftfreq(n_fft, 1 / SAMPLE_RATE)
    sel = (freqs >= 65) & (freqs <= 2000)
    pitch = (np.round(12 * np.log2(freqs[sel] / 440.0)) + 9) % 12  # 0 = Do
    chroma = np.zeros(12)
    for pc in range(12):
        chroma[pc] = (mag[:, sel][:, pitch == pc] ** 2).sum()
    chroma = np.sqrt(chroma)
    chroma /= chroma.sum() + 1e-9
    best = (-2.0, 0, "mayor")
    scores = []
    for mode, prof in (("mayor", _MAJOR), ("menor", _MINOR)):
        for tonic in range(12):
            c = np.corrcoef(chroma, np.roll(prof, tonic))[0, 1]
            scores.append(c)
            if c > best[0]:
                best = (c, tonic, mode)
    scores = np.sort(scores)[::-1]
    return {"tonic": int(best[1]), "mode": best[2], "name": f"{NOTES_ES[best[1]]} {best[2]}",
            "confidence": round(float(best[0] - scores[1]), 3)}
