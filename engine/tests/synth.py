"""Canción sintética para pruebas: bajo, acordes, batería y una voz con vibrato."""
import numpy as np

SR = 44100


def song(seconds=30.0, bpm=120.0, seed=1):
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    beat = 60.0 / bpm
    # batería: bombo en cada pulso, caja en 2 y 4
    drums = np.zeros(n)
    for k in range(int(seconds / beat)):
        i = int(k * beat * SR)
        L = int(0.12 * SR)
        env = np.exp(-np.arange(L) / (0.025 * SR))
        if k % 2 == 0:
            f = 110 * np.exp(-np.arange(L) / (0.03 * SR)) + 45
            drums[i:i + L] += (np.sin(2 * np.pi * np.cumsum(f) / SR) * env)[: n - i][:L]
        else:
            drums[i:i + L] += (rng.standard_normal(L) * env * 0.5)[: n - i][:L]
    # acordes de La menor: Am - Dm - E - Am (un compás cada uno)
    chords = [(220.0, 261.63, 329.63), (146.83, 174.61, 220.0), (164.81, 207.65, 246.94), (220.0, 261.63, 329.63)]
    bar = 4 * beat
    music = np.zeros(n)
    for j in range(int(seconds / bar) + 1):
        notes = chords[j % 4]
        a, b = int(j * bar * SR), min(n, int((j + 1) * bar * SR))
        seg = t[a:b]
        music[a:b] += sum(np.sin(2 * np.pi * f * seg) + 0.4 * np.sin(4 * np.pi * f * seg) for f in notes) * 0.12
        music[a:b] += np.sin(2 * np.pi * notes[0] / 2 * seg) * 0.3
    # voz: armónicos con vibrato y formantes, sílabas
    melody = np.array([440.0, 523.25, 493.88, 659.25, 440.0, 392.0, 493.88, 440.0])  # La, Do, Si, Mi...
    idx = np.minimum((t / (2 * beat)).astype(int) % len(melody), len(melody) - 1)
    f0 = melody[idx] * (1 + 0.012 * np.sin(2 * np.pi * 5.5 * t))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    voice = sum(np.sin(h * phase) * (1 / h) * np.exp(-((h * f0 - 900) / 700) ** 2) for h in range(1, 25))
    voice *= (np.sin(2 * np.pi * 1.5 * t) > -0.3) * 0.6
    mix = (drums * 0.6 + music + voice)
    mix = mix * (0.8 / np.abs(mix).max())
    stereo = np.stack([mix, mix * 0.97]).astype(np.float32)
    return stereo, {"drums": drums, "music": music, "voice": voice}
