"""Synthesises the film's soundtrack: a music bed plus sound design, timed from timeline.json.

The product sounds (cue tones and whispered lines) are the files the app itself ships in public/assets.
Everything else is generated here with numpy. Output: out/audio.wav (48 kHz stereo).
"""
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT.parent / "public" / "assets"
SR = 48000
timeline = json.loads((ROOT / "timeline.json").read_text())
cues = timeline["cues"]
N = int(timeline["seconds"] * SR)
rng = np.random.default_rng(7)

music = np.zeros((N, 2))
wet = np.zeros((N, 2))
sfx = np.zeros((N, 2))
voice = np.zeros((N, 2))


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def place(bus, at, mono, gain=1.0, pan=0.0):
    start = int(at * SR)
    if start >= N:
        return
    mono = mono[: N - start]
    angle = (pan + 1) * np.pi / 4
    bus[start:start + len(mono), 0] += mono * gain * np.cos(angle)
    bus[start:start + len(mono), 1] += mono * gain * np.sin(angle)


def lowpass(x, cutoff, order=2):
    return signal.sosfilt(signal.butter(order, cutoff, fs=SR, output="sos"), x, axis=0)


def highpass(x, cutoff, order=2):
    return signal.sosfilt(signal.butter(order, cutoff, fs=SR, output="sos"), x, axis=0)


def envelope(length, attack, release):
    n = int(length * SR)
    env = np.ones(n)
    a, r = min(int(attack * SR), n), min(int(release * SR), n)
    env[:a] = np.sin(np.linspace(0, np.pi / 2, a)) ** 2
    env[n - r:] *= np.cos(np.linspace(0, np.pi / 2, r)) ** 2
    return env


def pad(midi, length, cutoff=900.0):
    t = np.arange(int(length * SR)) / SR
    out = np.zeros((len(t), 2))
    for channel, cents in enumerate(((-7, 0, 6), (-5, 1, 8))):
        for detune in cents:
            f = hz(midi) * 2 ** (detune / 1200)
            out[:, channel] += signal.sawtooth(2 * np.pi * f * t + rng.uniform(0, 6.28)) / 3
    return lowpass(out, cutoff, 2)


def pluck(midi, length=1.6, bright=0.5):
    t = np.arange(int(length * SR)) / SR
    f = hz(midi)
    tone = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.42)
    tone += bright * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.18)
    tone += 0.3 * bright * np.sin(2 * np.pi * 3 * f * t) * np.exp(-t / 0.09)
    tone[: int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))
    return tone


def kick(length=0.5, top=95.0, bottom=42.0):
    t = np.arange(int(length * SR)) / SR
    f = bottom + (top - bottom) * np.exp(-t / 0.045)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.16)


def tap():
    t = np.arange(int(0.16 * SR)) / SR
    click = highpass(rng.standard_normal(len(t)), 2200) * np.exp(-t / 0.004)
    body = np.sin(2 * np.pi * (150 + 120 * np.exp(-t / 0.01)) * t) * np.exp(-t / 0.03)
    knock = np.sin(2 * np.pi * 1250 * t) * np.exp(-t / 0.012)
    return 0.5 * click + 0.9 * body + 0.25 * knock


def whoosh(length, low=300.0, high=2600.0):
    n = int(length * SR)
    noise = rng.standard_normal(n)
    u = np.linspace(0, 1, n)
    out = np.zeros(n)
    block = 512
    zi = np.zeros((2, 2))
    for start in range(0, n, block):
        centre = low + (high - low) * np.sin(np.pi * u[start]) ** 1.5
        sos = signal.butter(1, [centre * 0.7, centre * 1.4], btype="band", fs=SR, output="sos")
        sos = np.vstack([sos, sos])[:2]
        out[start:start + block], zi = signal.sosfilt(sos, noise[start:start + block], zi=zi)
    return out * np.sin(np.pi * u) ** 2


def travel(at, length, from_pan, to_pan, gain=0.5):
    body = whoosh(length)
    n = len(body)
    pan = np.linspace(from_pan, to_pan, n)
    angle = (pan + 1) * np.pi / 4
    start = int(at * SR)
    n = min(n, N - start)
    sfx[start:start + n, 0] += body[:n] * gain * np.cos(angle[:n])
    sfx[start:start + n, 1] += body[:n] * gain * np.sin(angle[:n])


def asset(name):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(ASSETS / name), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        check=True, capture_output=True,
    ).stdout
    data = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    return data / max(1e-9, np.max(np.abs(data)))


bank = {line["text"] + "|" + line["role"]: line["file"] for line in json.loads((ASSETS / "bank.json").read_text())["lines"]}

# ---------------------------------------------------------------- music bed
D2, A1 = 38, 33
CHORDS = [
    (0, 4, [D2, 45], 0.30, 420),
    (4, 8, [D2, 45, 64], 0.36, 520),
    (8, 12, [D2, 45, 53, 60, 64], 0.5, 760),
    (12, 16, [34, 41, 50, 57, 62], 0.5, 820),
    (16, 20, [29, 48, 57, 64, 67], 0.52, 900),
    (20, 24, [36, 43, 50, 64, 67], 0.52, 950),
    (24, 28, [D2, 45, 53, 60, 64], 0.5, 900),
    (28, 32, [46, 62, 65, 69], 0.34, 700),
    (32, 36, [43, 58, 65, 69, 72], 0.38, 760),
    (36, 38, [A1, 52, 62, 67], 0.46, 1200),
    (38, 42, [34, 41, 50, 57, 62, 65, 72], 0.74, 1700),
    (42, 46, [29, 41, 48, 57, 64, 67, 72], 0.72, 1700),
    (46, 50, [36, 43, 52, 60, 64, 67], 0.6, 1300),
    (50, 54, [43, 50, 58, 62, 65, 69], 0.6, 1300),
    (54, 61.4, [D2, 45, 54, 57, 64, 66, 69], 0.66, 1500),
]
for start, end, notes, gain, cutoff in CHORDS:
    length = end - start + 1.6
    env = envelope(length, 1.3 if start else 3.0, 1.9)[:, None]
    for note in notes:
        body = pad(note, length, cutoff) * env * gain * (0.16 if note > 47 else 0.2)
        seg = body[: N - int(start * SR)]
        music[int(start * SR):int(start * SR) + len(seg)] += seg
    if start >= 8:
        root = notes[0]
        t = np.arange(int(length * SR)) / SR
        bass = (np.sin(2 * np.pi * hz(root) * t) + 0.25 * np.sin(2 * np.pi * hz(root + 12) * t)) * env[:, 0]
        place(music, start, bass, 0.2 if start < 38 or start >= 54 else 0.3)

t_all = np.arange(N) / SR
drone = np.sin(2 * np.pi * hz(26) * t_all) * 0.11 * np.clip(t_all / 3, 0, 1) * np.clip((61.6 - t_all) / 3, 0, 1)
music += drone[:, None]
air = lowpass(highpass(rng.standard_normal((N, 2)), 3500), 9000) * 0.006
music += air * (np.clip(t_all / 2, 0, 1) * np.clip((61.5 - t_all) / 2, 0, 1))[:, None]


def chord_at(time):
    return next(notes for start, end, notes, _, _ in CHORDS if start <= time < end)


for section_start, section_end, level in ((18, 28, 0.085), (38, 54, 0.13)):
    step = 0
    for time in np.arange(section_start, section_end, 0.5):
        tones = [n + 12 for n in chord_at(time) if n > 47]
        note = tones[(step * 2 + (step // 4)) % len(tones)]
        accent = 1.0 if step % 4 == 0 else 0.7
        pan = 0.45 if step % 2 else -0.45
        place(music, time, pluck(note, bright=0.35), level * accent, pan)
        place(wet, time, pluck(note, bright=0.35), level * accent * 0.9, -pan)
        step += 1

for time in np.arange(10, 28, 1.0):
    place(music, time, kick(), 0.2 if int(time) % 2 == 0 else 0.11)
for time in np.arange(38, 54, 1.0):
    place(music, time, kick(), 0.34 if int(time) % 2 == 0 else 0.2)
    tick = highpass(rng.standard_normal(int(0.05 * SR)), 6000) * np.exp(-np.arange(int(0.05 * SR)) / SR / 0.012)
    place(music, time + 0.5, tick, 0.035, 0.3)

place(wet, 5.0, pluck(76, 3.0, 0.3), 0.3)
place(wet, 5.0, pluck(69, 3.0, 0.3), 0.22, -0.3)

# riser into the reveal, then the hit
riser_len = cues["reveal"] - 35.9
u = np.linspace(0, 1, int(riser_len * SR))
riser = highpass(rng.standard_normal(len(u)), 500) * u ** 3
riser = lowpass(riser, 7000) + 0.5 * np.sin(2 * np.pi * np.cumsum(60 + 140 * u ** 2) / SR) * u ** 2
place(sfx, 35.9, riser, 0.16)
for at, gain in ((cues["reveal"], 1.0), (cues["lockup"], 0.75)):
    boom = kick(2.4, 70, 30)
    boom *= np.exp(-np.arange(len(boom)) / SR / 0.9) / np.maximum(1e-9, np.exp(-np.arange(len(boom)) / SR / 0.16))
    place(sfx, at, np.clip(boom, -1.5, 1.5), 0.42 * gain)
    for note in (62, 69, 74, 81):
        place(wet, at, pluck(note, 3.5, 0.6), 0.16 * gain, (note % 5 - 2) / 4)
    shimmer = highpass(rng.standard_normal(int(1.8 * SR)), 5000) * np.exp(-np.arange(int(1.8 * SR)) / SR / 0.5)
    place(wet, at, shimmer, 0.035 * gain)

# ---------------------------------------------------------------- sound design
A_PAN, B_PAN = -0.55, 0.55
place(sfx, cues["tap"], tap(), 0.8, B_PAN)
travel(cues["tap"] + 0.15, cues["arrive"] - cues["tap"], B_PAN, A_PAN)
place(sfx, cues["arrive"], asset("cue-soft.mp3"), 0.42, A_PAN)
place(voice, cues["voice"], asset(bank["Slow down|B"]), 0.6, A_PAN * 0.6)
place(sfx, cues["receiptTap"], tap(), 0.7, A_PAN)
travel(cues["receiptTap"] + 0.1, cues["receiptArrive"] - cues["receiptTap"], A_PAN, B_PAN, 0.3)
place(sfx, cues["receiptArrive"], asset("cue-receipt.mp3"), 0.4, B_PAN)

for index, at in enumerate(cues["fan"]):
    if index < 3:
        for n in range(index + 1):
            place(sfx, at + n * 0.16, tap(), 0.6, 0.2)
    else:
        pop = kick(0.3, 320, 110)
        place(sfx, at, pop, 0.5, 0.2)
    place(wet, at, pluck((62, 65, 69, 72)[index] + 12, 2.2, 0.5), 0.2, 0.25)
place(sfx, cues["fold"], whoosh(0.7, 500, 1800), 0.25, 0.1)

place(wet, cues["assistant"], pluck(81, 3.0, 0.2), 0.2)
place(wet, cues["assistant"], pluck(88, 3.0, 0.2), 0.12)
travel(cues["draftLeave"], cues["draftPreview"] - cues["draftLeave"], 0.0, B_PAN, 0.3)
place(sfx, cues["draftLeave"] + 0.1, asset("cue-draft.mp3"), 0.36, B_PAN)
place(voice, cues["draftPreview"], asset(bank["Send: The judge on the left looks lost?|assistant"]), 0.52, B_PAN * 0.7)
place(sfx, cues["approveTap"], tap(), 0.85, B_PAN)
place(sfx, cues["approveTap"] + 0.12, asset("cue-sent.mp3"), 0.36, B_PAN)
travel(cues["approveTap"] + 0.25, cues["draftArrive"] - cues["approveTap"], B_PAN, A_PAN)
place(sfx, cues["draftVoice"] - 0.3, asset("cue-soft.mp3"), 0.36, A_PAN)
place(voice, cues["draftVoice"], asset(bank["The judge on the left looks lost|B"]), 0.58, A_PAN * 0.6)

for index, at in enumerate(cues["dots"]):
    place(wet, at, pluck((74, 78, 81, 86, 90)[index], 2.0, 0.6), 0.2, -0.5 + index / 4)
    place(sfx, at, tap(), 0.25, -0.5 + index / 4)
for at in (cues["stageLive"], cues["stageReveal"]):
    place(sfx, at, kick(0.6, 80, 36), 0.4)
travel(cues["lockupPulse"], 2.6, B_PAN, A_PAN, 0.4)
travel(cues["lockupPulse"] + 1.5, 2.6, A_PAN, B_PAN, 0.3)

# ---------------------------------------------------------------- reverb and mix
ir_t = np.arange(int(3.2 * SR)) / SR
ir = lowpass(rng.standard_normal((len(ir_t), 2)), 5200) * np.exp(-ir_t / 0.75)[:, None]
ir /= np.sqrt(np.sum(ir ** 2, axis=0))


def reverb(x, amount):
    return np.stack([signal.fftconvolve(x[:, c], ir[:, c])[:N] for c in range(2)], axis=1) * amount


duck = np.ones(N)
voice_level = np.abs(voice).max(axis=1)
follower = lowpass(np.minimum(1.0, signal.fftconvolve(voice_level, np.ones(int(0.5 * SR)) / (0.05 * SR))[:N]), 4)
duck -= 0.45 * np.clip(follower, 0, 1)

music_bus = (music + reverb(music, 0.05) + wet * 0.35 + reverb(wet, 0.22)) * duck[:, None]
sfx_bus = sfx + reverb(sfx, 0.07)
voice_bus = highpass(voice, 110) + reverb(voice, 0.035)
mix = music_bus * 1.0 + sfx_bus * 0.9 + voice_bus * 1.15
mix = highpass(mix, 24)
fade = np.clip(t_all / 1.2, 0, 1) * np.clip((timeline["seconds"] - 0.25 - t_all) / 1.6, 0, 1)
mix *= fade[:, None]
mix *= 0.89 / np.max(np.abs(mix))
mix = np.tanh(mix * 1.6) / np.tanh(1.6) * 0.89

out = ROOT / "out"
out.mkdir(exist_ok=True)
wavfile.write(out / "audio.wav", SR, (mix * 32767).astype(np.int16))
print(f"Wrote {out / 'audio.wav'}: {N / SR:.1f}s, peak {20 * np.log10(np.max(np.abs(mix))):.1f} dBFS")
