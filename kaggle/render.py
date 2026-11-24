"""Runs inside a Kaggle notebook (script kernel, internet ON).
Kaggle Secrets needed: WORKER_URL, JOB_TOKEN."""
import subprocess, sys, os, json, glob, asyncio, requests
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "edge-tts"], check=True)
import edge_tts
KOKORO = None
try:  # high-quality local voice (kokoro-onnx works on Python 3.13); any failure falls back to edge-tts
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "kokoro-onnx", "soundfile", "requests"], check=True)
    import requests as _rq
    _base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
    for _f in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        if not os.path.exists(_f):
            _r = _rq.get(_base + _f, timeout=300); _r.raise_for_status(); open(_f, "wb").write(_r.content)
    from kokoro_onnx import Kokoro
    KOKORO = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
    print("kokoro ready")
except Exception as e:
    print("kokoro unavailable, using edge-tts:", repr(e)[:200])
from kaggle_secrets import UserSecretsClient
INJ_URL, INJ_TOKEN = "__WORKER_URL__", "__RUN_TOKEN__"  # filled in by the Worker at push time (one-run token)
if INJ_TOKEN.startswith("rt_"):
    WORKER, TOKEN = INJ_URL, INJ_TOKEN
else:  # manual runs: fall back to Kaggle notebook secrets
    S = UserSecretsClient()
    WORKER, TOKEN = (S.get_secret(k) for k in ("WORKER_URL", "JOB_TOKEN"))
H = {"Authorization": f"Bearer {TOKEN}"}
VOICE, W, HT = "en-US-AndrewMultilingualNeural", 1080, 1920

import time
for _ in range(16):  # KV is eventually consistent; wait up to ~4 min for the job to appear
    r = requests.get(f"{WORKER}/job/next", headers=H)
    if r.status_code == 200: break
    print("no job yet, retrying", r.status_code); time.sleep(15)
else:
    print("no job"); sys.exit(0)
job = r.json(); os.makedirs("w", exist_ok=True)
def progress(step, done=0, total=0, msg=""):
    try: requests.post(f"{WORKER}/progress/{job['id']}", headers=H, json={"step": step, "done": done, "total": total, "msg": msg}, timeout=15)
    except Exception: pass
progress("start", 0, len(job["scenes"]), "Renderer started")
import traceback
def _report(t, v, tb):
    msg = "".join(traceback.format_exception(t, v, tb))[-900:]
    try: requests.post(f"{WORKER}/fail/{job['id']}", headers=H, data=msg.encode(), timeout=30)
    except Exception: pass
    sys.__excepthook__(t, v, tb)
sys.excepthook = _report

def sh(*a):
    r = subprocess.run(a, capture_output=True, text=True)
    if r.returncode:
        print("FFMPEG FAILED:", " ".join(a)[:300]); print(r.stderr[-1500:]); raise RuntimeError("ffmpeg failed: " + r.stderr[-700:])
def dur(f): return float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f]))
def fmt(t): return f"{int(t//3600)}:{int(t%3600//60):02d}:{t%60:05.2f}"

KVOICE = "af_heart"

def kokoro_tts(text, out, sub):
    import numpy as np, soundfile as sf
    audio, sr = KOKORO.create(text, voice=KVOICE, speed=0.9, lang="en-us")
    keep = np.where(np.abs(audio) > 0.01)[0]  # trim leading/trailing silence
    lo, hi = (max(int(keep[0]) - sr // 20, 0), min(int(keep[-1]) + sr // 7, len(audio))) if len(keep) else (0, len(audio))
    audio = audio[lo:hi]; total = len(audio) / float(sr)
    sf.write(out, audio, sr, format="WAV")
    ws = text.split(); wt = [len(w) + (4 if w[-1] in ".?!" else 2 if w[-1] in ",;:" else 0) for w in ws]
    t, words = 0.0, []
    for w, x in zip(ws, wt):
        d = total * x / sum(wt); words.append((t, t + d, w)); t += d
    json.dump(words, open(sub, "w"))

VOICES = [VOICE, "en-US-AriaNeural", "en-US-GuyNeural", "en-GB-SoniaNeural"]

async def tts(text, out, sub):
    if KOKORO is not None:
        try: kokoro_tts(text, out, sub); return
        except Exception as e: print("kokoro failed, falling back:", repr(e)[:200])
    last = None
    for attempt in range(8):
        voice = VOICES[min(attempt // 2, len(VOICES) - 1)]
        try:
            c = edge_tts.Communicate(text, voice); words = []
            with open(out, "wb") as f:
                async for ch in c.stream():
                    if ch["type"] == "audio": f.write(ch["data"])
                    elif ch["type"] == "WordBoundary": words.append((ch["offset"]/1e7, (ch["offset"]+ch["duration"])/1e7, ch["text"]))
            if os.path.getsize(out) > 1000 and words:
                json.dump(words, open(sub, "w")); return
            last = RuntimeError("empty audio")
        except Exception as e:
            last = e
        print("tts retry", attempt, voice, repr(last)[:120]); await asyncio.sleep(2 + attempt * 2)
    raise last

STYLE = "Cute friendly children's cartoon illustration, bright cheerful colors, soft rounded shapes, simple background, no text, no words, no letters: "

def clip(query, out, seconds):
    img = out + ".jpg"
    for _ in range(3):
        x = requests.post(f"{WORKER}/image", headers=H, json={"prompt": STYLE + query}, timeout=120)
        if x.status_code == 200 and len(x.content) > 1000:
            open(img, "wb").write(x.content); break
    else:
        sh("ffmpeg","-y","-f","lavfi","-i",f"color=c=0x4a90d9:s={W}x{HT}:d={seconds}","-c:v","libx264",out); return
    n = int(seconds * 30) + 1
    fc = (f"[0:v]split[a][b];[a]scale={W}:{HT}:force_original_aspect_ratio=increase,crop={W}:{HT},boxblur=40[bg];"
          f"[b]scale=2160:2160,zoompan=z='min(zoom+0.0006,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:s={W}x{W}:fps=30[fg];"
          f"[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p")
    sh("ffmpeg","-y","-loop","1","-i",img,"-filter_complex",fc,"-t",f"{seconds:.2f}","-r","30","-an","-c:v","libx264","-preset","veryfast",out)

KEYS = {w.strip(".,!?;:'\"").lower() for k in job.get("keywords") or [] for w in str(k).split()}
HOOK = (job.get("hook") or job.get("title") or "").upper()
segs, ass, t0, durs, timings = [], [], 0.0, [], []
for i, sc in enumerate(job["scenes"]):
    a, sub, v = f"w/a{i}.audio", f"w/s{i}.json", f"w/v{i}.mp4"
    asyncio.run(tts(sc["narration"], a, sub)); d = dur(a) + 0.3
    progress("voice", i, len(job["scenes"]))
    clip(sc["visual_query"], v, d)
    progress("scene", i + 1, len(job["scenes"]), f"Scene {i+1}/{len(job['scenes'])} ready")
    sh("ffmpeg","-y","-i",v,"-i",a,"-t",f"{d:.2f}","-c:v","copy","-c:a","aac","-ar","44100",f"w/seg{i}.mp4")
    segs.append(f"w/seg{i}.mp4")
    words = json.load(open(sub))
    for k in range(0, len(words), 3):  # 3-word burned-in captions
        g = words[k:k+3]
        txt = " ".join(("{\\c&H00E0FF&}" + x[2].upper() + "{\\r}") if x[2].strip(".,!?;:'\"").lower() in KEYS else x[2].upper() for x in g)
        ass.append(f"Dialogue: 0,{fmt(t0+g[0][0])},{fmt(t0+g[-1][1]+0.1)},C,,0,0,0,,{txt}")
    durs.append(d); timings.append([round(t0, 2), round(t0 + d, 2)])
    t0 += d
open("w/subs.ass","w").write(f"""[Script Info]
PlayResX: {W}
PlayResY: {HT}
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BorderStyle,Outline,Alignment,MarginV
Style: C,DejaVu Sans,74,&H00FFFFFF,&H00000000,1,6,2,520
Style: T,DejaVu Sans,100,&H0000E0FF,&H00000000,1,8,8,230
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
""" + (f"Dialogue: 1,{fmt(0)},{fmt(2.8)},T,,0,0,0,,{{\\fad(250,400)}}{HOOK}\n" if HOOK else "") + "\n".join(ass))
progress("assemble", len(job["scenes"]), len(job["scenes"]), "Assembling final video")
open("w/list.txt","w").write("".join(f"file '{os.path.abspath(s)}'\n" for s in segs))
sh("ffmpeg","-y","-f","concat","-safe","0","-i","w/list.txt","-vf","ass=w/subs.ass","-c:v","libx264","-preset","veryfast","-crf","28","-c:a","aac","-movflags","+faststart","out.mp4")
print("size MB", os.path.getsize("out.mp4")/1e6)
progress("upload", 0, 0, "Uploading video")
requests.put(f"{WORKER}/upload/{job['id']}", headers=H, data=open("out.mp4","rb")).raise_for_status()
print("uploaded", job["id"])

def dub_track(lang, cfg, narrs):  # one dubbed audio file per language, each scene fitted to the English scene length
    import soundfile as sf
    parts = []
    for i, (txt, d) in enumerate(zip(narrs, durs)):
        wav, out = f"w/d_{lang}_{i}.wav", f"w/dp_{lang}_{i}.wav"
        audio, sr = KOKORO.create(txt, voice=cfg["voice"], speed=0.9, lang=cfg["lang"]); sf.write(wav, audio, sr, format="WAV")
        r = dur(wav) / max(d - 0.2, 0.5); af = (f"atempo={min(r, 1.6):.3f}," if r > 1.0 else "") + f"apad=whole_dur={d:.3f}"
        sh("ffmpeg", "-y", "-i", wav, "-af", af, "-t", f"{d:.3f}", "-ar", "44100", "-ac", "1", out); parts.append(out)
    open(f"w/dl_{lang}.txt", "w").write("".join(f"file '{os.path.abspath(p)}'\n" for p in parts))
    m4a = f"w/dub_{lang}.m4a"; sh("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", f"w/dl_{lang}.txt", "-c:a", "aac", "-b:a", "96k", m4a); return m4a
try: requests.post(f"{WORKER}/upload/{job['id']}/meta", headers=H, json={"timings": timings}, timeout=30)
except Exception as e: print("timings upload failed", repr(e)[:120])
for lang, cfg in (job.get("dubs") or {}).items():  # failures here never block the main video
    if KOKORO is None: print("no kokoro, skipping dubs"); break
    try:
        progress("assemble", len(job["scenes"]), len(job["scenes"]), f"Recording {lang} audio")
        m4a = dub_track(lang, cfg, job["tr"][lang]["narrations"])
        requests.put(f"{WORKER}/upload/{job['id']}/audio/{lang}", headers=H, data=open(m4a, "rb"), timeout=120).raise_for_status(); print("dub uploaded", lang)
    except Exception as e:
        print("dub failed", lang, repr(e)[:300]); progress("assemble", len(job["scenes"]), len(job["scenes"]), f"{lang} audio skipped: {repr(e)[:80]}")
x = requests.post(f"{WORKER}/publish/{job['id']}/review", headers=H, timeout=120); print("review", x.status_code, x.text[:200])
