#!/usr/bin/env python3
"""
book2audio.py - page images of a Hebrew book -> one MP3 audiobook with chapters.

One command, no manual steps, setup included:

    python3 book2audio.py ~/Downloads/worthy

The first run installs whatever is missing. It is safe to re-run; it only
fills gaps:
  * Homebrew formulas tesseract, ffmpeg, python@3.12 (Homebrew itself must exist)
  * the tesseract OCR model for --ocr-lang (checksum-verified for heb)
  * a private Python venv with pinned package versions
  * the speech models (Kokoro Hebrew + Phonikud), checksum-verified

Then the pipeline. Each stage caches its work under --work, so a rerun resumes:
  1. ocr       every image in natural file-name order, several at once
  2. clean     drop lines repeated on most pages (the running header), the
               reader's footer bar, blank pages, pages without the header
               (stray screenshots) and consecutive duplicate pages
  3. chapters  normalise "<chapter-word> N" headings; fix a single number that
               breaks the 1,2,3 sequence (OCR reads 30 as 80); every fix logged
  4. metadata  title and author parsed from the header "title | author"
  5. speech    Kokoro Hebrew voice, chunk by chunk, parallel workers
  6. encode    one MP3 with ID3 chapter marks (or m4a with MP4 chapters)
  7. verify    duration, chapter count, last chapter ends at the file's end;
               exit code 1 if anything is off

Everything the run decided is written to <work>/report.txt.
To correct OCR text by hand: edit <work>/book.txt, then re-run with
--text <work>/book.txt (stages 1-4 are skipped, title/author are kept).
"""

import argparse
import collections
import concurrent.futures
import difflib
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

# ---------------------------------------------------------------- pinned sources

PYTHON_CANDIDATES = ("python3.12", "python3.13", "python3.11")
BREW_PYTHON = "python@3.12"

PIP_PACKAGES = (
    "kokoro-onnx==0.6.1",
    "phonikud==0.4.1",
    "phonikud-onnx==1.0.6",
    "onnxruntime==1.21.1",
    "soundfile==0.14.0",
)

_KOKORO = ("https://huggingface.co/thewh1teagle/kokoro-hebrew-nc/resolve/"
           "07e2334fc252d7965cb8dbd503bf7565bad71228/")
_PHONIKUD = ("https://huggingface.co/Phonikud/phonikud-onnx/resolve/"
             "b806189fe1fc0085b1012b7560ffb5e8ecfd72a2/")
MODELS = {
    "kokoro.onnx": (_KOKORO + "kokoro.onnx",
        "6b9b16fbba87fec17a21cd3b11203286e1e657014dbab236703fdf0cf13a9a2f"),
    "voices-hebrew.bin": (_KOKORO + "voices-hebrew.bin",
        "5efaa05741532c144a535677f02e02fd72c76fd8ec45840d6e3194b38194e9a7"),
    "config.json": (_KOKORO + "config.json",
        "042f62ac55870757c2945a3a8d4b7fb01a9f9f775c12b1ef09f41fef1efd24f5"),
    "phonikud-1.0.int8.onnx": (_PHONIKUD + "phonikud-1.0.int8.onnx",
        "113afb58d3140502aa1e7691cdc6b240b56cf97e5852fc870e1a7fb5a400dd62"),
}

_TESSDATA = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/{rev}/{lang}.traineddata"
TESSDATA_PINS = {   # lang -> (commit, sha256); other langs are fetched from main
    "heb": ("9ddc24e750eec0994223a9edc3fcb434a2244f3b",
            "dbaa827aea6bc21215638447f17783a1004987c2d0bf5573d111fee397abdae5"),
}

IMAGE_EXT = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp")
SAMPLE_RATE = 24000

# ---------------------------------------------------------------- small helpers


def say(msg=""):
    print(msg, flush=True)


def die(msg, code=2):
    print("error: " + msg, file=sys.stderr, flush=True)
    sys.exit(code)


def run(cmd, **kw):
    say("  $ " + " ".join(cmd))
    p = subprocess.run(cmd, **kw)
    if p.returncode != 0:
        die("command failed (exit %d): %s" % (p.returncode, " ".join(cmd)))
    return p


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(url, dest, sha256=None, no_install=False):
    """Download url to dest atomically and verify it. Skips a file that matches."""
    if os.path.exists(dest) and (sha256 is None or sha256_of(dest) == sha256):
        return
    if no_install:
        die("missing or corrupt %s (--no-install set)" % dest)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    say("  download %s" % os.path.basename(dest))
    run(["curl", "-fL", "--retry", "3", "--progress-bar", "-o", tmp, url])
    if sha256 is not None:
        got = sha256_of(tmp)
        if got != sha256:
            os.remove(tmp)
            die("checksum mismatch for %s\n  got  %s\n  want %s" % (url, got, sha256))
    os.replace(tmp, dest)


def brew_bin():
    for p in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
        if os.path.exists(p):
            return p
    return shutil.which("brew")


def natural_key(name):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def fmt_min(seconds):
    return "%.1f min" % (seconds / 60.0)


# ---------------------------------------------------------------- setup (stdlib)


def setup(args):
    """Install or verify everything. Returns the venv python path."""
    home = args.home
    say("setup: %s" % home)
    os.makedirs(home, exist_ok=True)

    # 1. command line tools from Homebrew
    missing = sorted({f for tool, f in (("tesseract", "tesseract"),
                                         ("ffmpeg", "ffmpeg"),
                                         ("ffprobe", "ffmpeg"),
                                         ("curl", "curl"))
                      if not shutil.which(tool)})
    if missing:
        brew = brew_bin()
        if not brew:
            die("Homebrew is not installed. Install it from https://brew.sh, "
                "then re-run. Missing: %s" % ", ".join(missing))
        if args.no_install:
            die("missing tools (--no-install set): %s" % ", ".join(missing))
        run([brew, "install", *missing])

    # 2. OCR language data, kept in our own folder, so the system is untouched
    for lang in args.ocr_lang.split("+"):
        rev, sha = TESSDATA_PINS.get(lang, ("main", None))
        fetch(_TESSDATA.format(rev=rev, lang=lang),
              os.path.join(home, "tessdata", lang + ".traineddata"),
              sha, args.no_install)

    # 3. private venv with pinned packages
    venv = os.path.join(home, "venv-book2audio")
    py = os.path.join(venv, "bin", "python")
    stamp = os.path.join(venv, ".book2audio-packages")
    want = "\n".join(PIP_PACKAGES)
    current = open(stamp).read() if os.path.exists(stamp) else None
    if not (os.path.exists(py) and current == want):
        if args.no_install:
            die("venv missing or outdated at %s (--no-install set)" % venv)
        base = next((p for p in (shutil.which(n) for n in PYTHON_CANDIDATES) if p), None)
        if base is None:
            brew = brew_bin() or die("Homebrew is required to install %s" % BREW_PYTHON)
            run([brew, "install", BREW_PYTHON])
            base = next((p for p in (shutil.which(n) for n in PYTHON_CANDIDATES) if p), None)
            if base is None:
                die("could not find python 3.11-3.13 after installing %s" % BREW_PYTHON)
        if not os.path.exists(py):
            run([base, "-m", "venv", venv])
        run([py, "-m", "pip", "install", "-q", "--upgrade", "pip"])
        run([py, "-m", "pip", "install", "-q", *PIP_PACKAGES])
        with open(stamp, "w") as fh:
            fh.write(want)

    # 4. speech models
    for name, (url, sha) in MODELS.items():
        fetch(url, os.path.join(home, "models", name), sha, args.no_install)

    say("setup: ok")
    return py


# ---------------------------------------------------------------- stage 1: OCR


def stage_ocr(images_dir, work, args, rep):
    names = sorted((n for n in os.listdir(images_dir)
                    if n.lower().endswith(IMAGE_EXT) and not n.startswith(".")),
                   key=natural_key)
    if not names:
        die("no images (%s) in %s" % (", ".join(IMAGE_EXT), images_dir))
    out_dir = os.path.join(work, "ocr")
    os.makedirs(out_dir, exist_ok=True)
    tessdata = os.path.join(args.home, "tessdata")
    env = dict(os.environ, OMP_THREAD_LIMIT="1")

    def one(name):
        src = os.path.join(images_dir, name)
        base = os.path.join(out_dir, os.path.splitext(name)[0])
        txt = base + ".txt"
        if not (os.path.exists(txt) and os.path.getmtime(txt) >= os.path.getmtime(src)):
            p = subprocess.run(["tesseract", src, base, "-l", args.ocr_lang,
                                "--tessdata-dir", tessdata],
                               capture_output=True, text=True, env=env)
            if p.returncode != 0:
                return name, None, p.stderr.strip()[-300:]
        with open(txt, encoding="utf-8", errors="replace") as fh:
            return name, fh.read(), None

    say("\n[1/7] ocr: %d images, lang %s" % (len(names), args.ocr_lang))
    t0 = time.time()
    pages, done = {}, 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as ex:
        for name, text, err in ex.map(one, names):
            done += 1
            if err is not None:
                rep.add("ocr failed: %s: %s" % (name, err))
                continue
            pages[name] = text
            if done % 20 == 0 or done == len(names):
                say("  %d/%d" % (done, len(names)))
    say("  %.0f s" % (time.time() - t0))
    return [(n, pages[n]) for n in names if n in pages]


# ---------------------------------------------------------------- stage 2: clean

COUNTER = re.compile(r"^[\d\s\\/|%.]+$")
HEB_LETTER = re.compile(r"[א-ת]")
PAGE_NO = re.compile(r"(\d+)\s*\\")


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def is_footer(s):
    """The reader's bottom bar: bookmark icon, page counter, percent.

    OCR renders it as things like '₪1 218 \\ 0 20'. Never more than a few
    stray Hebrew letters and always a counter, so a real line cannot match.
    """
    if len(s) > 32 or len(HEB_LETTER.findall(s)) > 4:
        return False
    return "₪" in s or (("\\" in s or "/" in s) and any(c.isdigit() for c in s))


def stage_clean(pages, args, rep):
    say("\n[2/7] clean")
    n = len(pages)
    counts = collections.Counter()
    for _, txt in pages:
        for line in {norm(l) for l in txt.splitlines() if norm(l)}:
            counts[line] += 1

    if n >= 3:
        need = max(3, int(n * args.header_ratio))
        furniture = {l for l, c in counts.items() if c >= need}
    else:
        furniture = set()
        rep.add("only %d pages: repeated-header detection skipped" % n)

    candidates = sorted((l for l in furniture
                         if not COUNTER.match(l) and not is_footer(l) and len(l) > 3),
                        key=lambda l: -counts[l])
    header = candidates[0] if candidates else None
    rep.add("pages read: %d" % n)
    for l in sorted(furniture, key=lambda x: -counts[x]):
        rep.add("dropped as repeated furniture (%d/%d pages): %s" % (counts[l], n, l))
    if header is None:
        rep.add("no running header found: no page is excluded for lacking one")

    kept, excluded, prev_body, page_numbers = [], [], None, []
    for name, txt in pages:
        flat = norm(txt)
        for line in txt.splitlines():
            if is_footer(norm(line)):
                m = PAGE_NO.search(line)
                if m:
                    page_numbers.append((name, int(m.group(1))))
        body = "\n".join(s for s in (norm(l) for l in txt.splitlines())
                         if s and s not in furniture and not COUNTER.match(s)
                         and not is_footer(s)).strip()
        if not body:
            excluded.append((name, "blank page"))
            continue
        if header and not (header in flat or difflib.SequenceMatcher(
                None, header, flat[:120]).ratio() > 0.45):
            excluded.append((name, "no running header (not a book page?)"))
            continue
        if prev_body and difflib.SequenceMatcher(
                None, prev_body[:2000], body[:2000]).ratio() > 0.95:
            excluded.append((name, "duplicate of the previous page"))
            continue
        kept.append(body)
        prev_body = body

    for name, why in excluded:
        rep.add("excluded %s: %s" % (name, why))
    for (a, pa), (b, pb) in zip(page_numbers, page_numbers[1:]):
        if pb <= pa:
            rep.add("page counter went back or stalled: %s=%d then %s=%d"
                    % (a, pa, b, pb))
    rep.add("pages used: %d of %d" % (len(kept), n))
    say("  used %d of %d pages, header: %s" % (len(kept), n, header or "(none)"))
    return "".join(b + "\n\n" for b in kept), header


# ---------------------------------------------------------------- stage 3: chapters


def stage_chapters(text, args, rep):
    say("\n[3/7] chapters")
    word = re.escape(args.chapter_word)
    head = re.compile(r"^\s*%s\s*(\d+)\s*$" % word)
    lines = text.split("\n")
    heads = []
    for i, line in enumerate(lines):
        m = head.match(line)
        if m:
            heads.append([i, int(m.group(1))])
            want = "%s %s" % (args.chapter_word, m.group(1))
            if line != want:
                rep.add("chapter heading normalised: %r -> %r" % (line, want))
                lines[i] = want

    if not args.no_chapter_fix and len(heads) >= 2:
        nums = [h[1] for h in heads]
        if nums[0] != nums[1] - 1 and nums[1] - 1 >= 1 and \
                (len(nums) < 3 or nums[2] == nums[1] + 1):
            rep.add("chapter number fixed: %d -> %d (first heading)" % (nums[0], nums[1] - 1))
            nums[0] = nums[1] - 1
        for k in range(1, len(nums)):
            expect = nums[k - 1] + 1
            if nums[k] == expect:
                continue
            nxt = nums[k + 1] if k + 1 < len(nums) else None
            if nxt is None or nxt == expect + 1:
                rep.add("chapter number fixed: %d -> %d (breaks the sequence)"
                        % (nums[k], expect))
                nums[k] = expect
            else:
                rep.add("chapter number %d left as read: sequence ambiguous" % nums[k])
        for h, v in zip(heads, nums):
            lines[h[0]] = "%s %d" % (args.chapter_word, v)

    found = [h for h in lines if head.match(h)]
    rep.add("chapters found: %d" % len(found))
    say("  %d chapters" % len(found))
    return "\n".join(lines)


# ---------------------------------------------------------------- stage 4: metadata


def stage_meta(header, images_dir, args, rep):
    title, author = None, None
    if header and "|" in header:
        left, _, right = header.partition("|")
        title, author = left.strip() or None, right.strip() or None
    elif header:
        title = header
    title = args.title or title or os.path.basename(images_dir.rstrip("/"))
    author = args.author or author or ""
    rep.add("title: %s" % title)
    rep.add("author: %s" % (author or "(none)"))
    say("\n[4/7] metadata: %s / %s" % (title, author or "(no author)"))
    return title, author


# ---------------------------------------------------------------- stage 5: speech


def split_chunks(text, max_chars):
    """Sentence-aware split so the voice pauses in the right places."""
    parts, buf = [], ""
    for raw in text.split("\n"):
        raw = raw.strip()
        if not raw:
            continue
        for sent in re.split(r"(?<=[.!?:;])\s+", raw):
            sent = sent.strip()
            if not sent:
                continue
            if len(buf) + len(sent) + 1 <= max_chars:
                buf = (buf + " " + sent).strip()
                continue
            if buf:
                parts.append(buf)
            while len(sent) > max_chars:
                cut = sent.rfind(",", 0, max_chars)
                cut = cut if cut > max_chars // 3 else max_chars
                parts.append(sent[:cut].strip())
                sent = sent[cut:].strip(" ,")
            buf = sent
    if buf:
        parts.append(buf)
    return parts


def build_plan(text, chapter_word, max_chars):
    """[(chapter label or None, text to speak)] in reading order."""
    head = re.compile(r"^%s (\d+)$" % re.escape(chapter_word))
    lines, plan, buf, i = text.split("\n"), [], [], 0
    while i < len(lines):
        m = head.match(lines[i].strip())
        if m:
            if buf:
                plan += [(None, c) for c in split_chunks("\n".join(buf), max_chars)]
                buf = []
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            title = lines[j].strip() if j < len(lines) else ""
            label = "%s - %s" % (lines[i].strip(), title) if title else lines[i].strip()
            plan.append((label, "%s. %s." % (lines[i].strip(), title) if title
                         else lines[i].strip() + "."))
            i = j + 1 if title else i + 1
            continue
        buf.append(lines[i])
        i += 1
    if buf:
        plan += [(None, c) for c in split_chunks("\n".join(buf), max_chars)]
    return plan


_W = {}


def _worker_init(models, voice, speed, threads, provider):
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    from phonikud_onnx import Phonikud
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    prov = ["CoreMLExecutionProvider", "CPUExecutionProvider"] \
        if provider == "coreml" else ["CPUExecutionProvider"]
    ks = ort.InferenceSession(os.path.join(models, "kokoro.onnx"), so, providers=prov)
    ps = ort.InferenceSession(os.path.join(models, "phonikud-1.0.int8.onnx"), so,
                              providers=["CPUExecutionProvider"])
    _W["ko"] = Kokoro.from_session(ks, os.path.join(models, "voices-hebrew.bin"),
                                   vocab_config=os.path.join(models, "config.json"))
    _W["ph"] = Phonikud.from_session(ps)
    _W["voice"], _W["speed"] = voice, speed


def _render(job):
    text, path = job
    if os.path.exists(path):
        return path
    import soundfile as sf
    from phonikud import phonemize
    phon = phonemize(_W["ph"].add_diacritics(text))
    samples, sr = _W["ko"].create(phon, voice=_W["voice"], speed=_W["speed"],
                                  is_phonemes=True)
    tmp = path[:-4] + ".part.wav"
    sf.write(tmp, samples, sr, subtype="PCM_16")
    os.replace(tmp, path)     # atomic: a crash never leaves a half-written wav
    return path


def stage_speech(plan, work, args, rep):
    import multiprocessing as mp
    import numpy as np
    import soundfile as sf
    models = os.path.join(args.home, "models")
    cdir = os.path.join(work, "chunks")
    os.makedirs(cdir, exist_ok=True)

    jobs = []
    for _, text in plan:
        key = hashlib.sha1(("%s|%.3f|%s" % (args.voice, args.speed, text))
                           .encode("utf-8")).hexdigest()[:16]
        jobs.append((text, os.path.join(cdir, key + ".wav")))
    todo = [j for j in jobs if not os.path.exists(j[1])]
    cpus = os.cpu_count() or 4
    workers = args.workers or max(1, min(4, cpus // 4))
    threads = max(1, cpus // workers)
    say("\n[5/7] speech: %d chunks, %d cached, %d to render, %d workers x %d threads, %s"
        % (len(jobs), len(jobs) - len(todo), len(todo), workers, threads, args.provider))

    if todo:
        # load once here: checks the voice, and fetches the diacritics
        # tokenizer before the workers start, so they can run offline
        from kokoro_onnx import Kokoro
        from phonikud_onnx import Phonikud
        k = Kokoro(os.path.join(models, "kokoro.onnx"),
                   os.path.join(models, "voices-hebrew.bin"),
                   vocab_config=os.path.join(models, "config.json"))
        if args.voice not in k.get_voices():
            die("voice %r not in model; available: %s" % (args.voice, k.get_voices()))
        Phonikud(os.path.join(models, "phonikud-1.0.int8.onnx"))
        del k
        os.environ["HF_HUB_OFFLINE"] = "1"

        t0, done, last = time.time(), 0, 0.0
        ctx = mp.get_context("spawn")
        with ctx.Pool(workers, initializer=_worker_init,
                      initargs=(models, args.voice, args.speed, threads, args.provider)) as pool:
            for _ in pool.imap_unordered(_render, todo):
                done += 1
                now = time.time()
                if now - last > 15 or done == len(todo):
                    last = now
                    el = now - t0
                    say("  %d/%d  elapsed %s  eta %s" % (
                        done, len(todo), fmt_min(el),
                        fmt_min(el / done * (len(todo) - done))))
        rep.add("speech render: %d chunks in %s (%d workers)"
                % (len(todo), fmt_min(time.time() - t0), workers))

    gap = os.path.join(cdir, "_gap_%.2f.wav" % args.gap)
    if not os.path.exists(gap):
        sf.write(gap, np.zeros(int(SAMPLE_RATE * args.gap), dtype=np.float32),
                 SAMPLE_RATE, subtype="PCM_16")
    files, marks, clock = [], [], 0.0
    for (label, _), (_, path) in zip(plan, jobs):
        if label:
            files.append(gap)
            clock += args.gap
            marks.append((clock, label))
        files.append(path)
        clock += sf.info(path).duration
    return files, marks, clock


# ---------------------------------------------------------------- stage 6: encode


def ffmeta_escape(s):
    return re.sub(r"([=;#\\\n])", r"\\\1", s)


def stage_encode(files, marks, total, out, title, author, work, args):
    say("\n[6/7] encode: %s" % out)
    lst = os.path.join(work, "concat.txt")
    with open(lst, "w", encoding="utf-8") as fh:
        for f in files:
            fh.write("file '%s'\n" % f.replace("'", "'\\''"))
    meta = os.path.join(work, "ffmeta.txt")
    with open(meta, "w", encoding="utf-8") as fh:
        fh.write(";FFMETADATA1\n")
        fh.write("title=%s\nalbum=%s\n" % (ffmeta_escape(title), ffmeta_escape(title)))
        if author:
            fh.write("artist=%s\n" % ffmeta_escape(author))
        fh.write("genre=Audiobook\n")
        for i, (start, label) in enumerate(marks):
            end = marks[i + 1][0] if i + 1 < len(marks) else total
            fh.write("[CHAPTER]\nTIMEBASE=1/1000\nSTART=%d\nEND=%d\ntitle=%s\n"
                     % (round(start * 1000), round(end * 1000), ffmeta_escape(label)))
    if args.format == "mp3":
        codec = ["-ar", "44100", "-ac", "1", "-c:a", "libmp3lame",
                 "-b:a", args.bitrate, "-id3v2_version", "3", "-f", "mp3"]
    else:
        codec = ["-c:a", "aac", "-b:a", args.bitrate, "-f", "ipod"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    tmp = out + ".part"
    t0 = time.time()
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", lst, "-i", meta, "-map_metadata", "1", "-map_chapters", "1",
         *codec, tmp])
    os.replace(tmp, out)
    say("  %.0f s" % (time.time() - t0))


# ---------------------------------------------------------------- stage 7: verify


def stage_verify(out, marks, total, title, rep):
    say("\n[7/7] verify")
    p = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json",
                        "-show_format", "-show_chapters", out],
                       capture_output=True, text=True)
    if p.returncode != 0:
        rep.add("VERIFY FAIL: ffprobe could not read the file")
        return False
    info = json.loads(p.stdout)
    dur = float(info["format"]["duration"])
    chapters = info.get("chapters", [])
    tags = {k.lower(): v for k, v in info["format"].get("tags", {}).items()}
    checks = [
        ("duration %.1f s matches the rendered audio %.1f s" % (dur, total),
         abs(dur - total) <= 1.0),
        ("chapter count %d == %d" % (len(chapters), len(marks)),
         len(chapters) == len(marks)),
        ("title tag is %r" % title, tags.get("title") == title),
    ]
    if chapters:
        end = float(chapters[-1]["end_time"])
        checks.append(("last chapter ends at %.1f s, file ends at %.1f s" % (end, dur),
                       abs(end - dur) <= 1.0))
    ok = True
    for text, good in checks:
        say("  %s  %s" % ("PASS" if good else "FAIL", text))
        rep.add("verify %s: %s" % ("PASS" if good else "FAIL", text))
        ok = ok and good
    return ok


# ---------------------------------------------------------------- driver


class Report:
    def __init__(self, work):
        self.path, self.lines = os.path.join(work, "report.txt"), []

    def add(self, line):
        self.lines.append(line)

    def write(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(self.lines) + "\n")


def safe_name(s):
    s = re.sub(r'[\x00-\x1f/\\:*?"<>|]+', "-", s).strip(" .-")
    return s or "audiobook"


def pipeline(args):
    images_dir = os.path.abspath(os.path.expanduser(args.images))
    if not os.path.isdir(images_dir):
        die("not a folder: %s" % images_dir)
    work = os.path.abspath(os.path.expanduser(args.work or
                                              os.path.join(images_dir, ".book2audio")))
    os.makedirs(work, exist_ok=True)
    rep = Report(work)
    meta_file = os.path.join(work, "meta.json")
    t_start = time.time()

    if args.text:
        with open(args.text, encoding="utf-8") as fh:
            text = fh.read()
        saved = json.load(open(meta_file)) if os.path.exists(meta_file) else {}
        title = args.title or saved.get("title") or os.path.basename(images_dir)
        author = args.author if args.author is not None else saved.get("author", "")
        rep.add("text from %s (stages 1-4 skipped)" % args.text)
        say("text: %s" % args.text)
    else:
        pages = stage_ocr(images_dir, work, args, rep)
        text, header = stage_clean(pages, args, rep)
        text = stage_chapters(text, args, rep)
        title, author = stage_meta(header, images_dir, args, rep)
        with open(os.path.join(work, "book.txt"), "w", encoding="utf-8") as fh:
            fh.write(text)
        with open(meta_file, "w", encoding="utf-8") as fh:
            json.dump({"title": title, "author": author}, fh, ensure_ascii=False)
    rep.add("words: %d" % len(text.split()))

    if args.text_only:
        rep.write()
        say("\ntext written to %s\nreport: %s" % (os.path.join(work, "book.txt"), rep.path))
        return 0

    plan = build_plan(text, args.chapter_word, args.max_chars)
    if args.limit_chunks:
        plan = plan[:args.limit_chunks]
    files, marks, total = stage_speech(plan, work, args, rep)

    out = os.path.abspath(os.path.expanduser(
        args.out or os.path.join(images_dir, safe_name(title) + "." + args.format)))
    stage_encode(files, marks, total, out, title, author, work, args)
    ok = stage_verify(out, marks, total, title, rep)

    size = os.path.getsize(out) / 1048576.0
    rep.add("output: %s (%.2f hours, %d chapters, %.0f MB)"
            % (out, total / 3600, len(marks), size))
    rep.add("total time: %s" % fmt_min(time.time() - t_start))
    if args.cleanup and ok:
        shutil.rmtree(os.path.join(work, "chunks"), ignore_errors=True)
        rep.add("chunk cache deleted (--cleanup)")
    rep.write()
    say("\n%s  %s\n  %.2f hours, %d chapters, %.0f MB\n  report: %s"
        % ("DONE" if ok else "VERIFY FAILED", out, total / 3600, len(marks), size, rep.path))
    return 0 if ok else 1


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        prog="book2audio.py",
        description="Page images of a Hebrew book -> one MP3 audiobook with chapters. "
                    "Setup included; see the top of the file for the stages.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("images", nargs="?", help="folder of page images, read in name order")
    g = ap.add_argument_group("output")
    g.add_argument("--out", help="output file (default: <images>/<title>.<format>)")
    g.add_argument("--format", default="mp3", choices=["mp3", "m4a"])
    g.add_argument("--bitrate", default="64k", help="audio bitrate")
    g.add_argument("--title", help="title tag (default: parsed from the page header)")
    g.add_argument("--author", help="author tag (default: parsed from the page header)")
    g = ap.add_argument_group("text")
    g.add_argument("--ocr-lang", default="heb", help="tesseract language(s), e.g. heb+eng")
    g.add_argument("--header-ratio", type=float, default=0.6,
                   help="a line on at least this share of pages is page furniture")
    g.add_argument("--chapter-word", default="פרק", help="word that starts a chapter heading")
    g.add_argument("--no-chapter-fix", action="store_true",
                   help="keep chapter numbers exactly as OCR read them")
    g.add_argument("--text", help="speak this text file instead of running OCR "
                                  "(e.g. a hand-corrected <work>/book.txt)")
    g.add_argument("--text-only", action="store_true",
                   help="stop after writing <work>/book.txt and the report")
    g = ap.add_argument_group("voice")
    g.add_argument("--voice", default="he_shaul")
    g.add_argument("--speed", type=float, default=1.0, help="1.0 = natural pace")
    g.add_argument("--gap", type=float, default=1.2, help="seconds of silence before a chapter")
    g.add_argument("--max-chars", type=int, default=220, help="max characters per spoken chunk")
    g.add_argument("--workers", type=int, default=0, help="parallel speech processes (0 = auto)")
    g.add_argument("--provider", default="cpu", choices=["cpu", "coreml"],
                   help="ONNX execution provider for the voice model")
    g.add_argument("--limit-chunks", type=int, help="render only the first N chunks (a sample)")
    g = ap.add_argument_group("setup and caches")
    g.add_argument("--home", default="~/hebrew-tts", help="venv, models and OCR data live here")
    g.add_argument("--work", help="cache folder (default: <images>/.book2audio)")
    g.add_argument("--setup-only", action="store_true", help="install/verify, then exit")
    g.add_argument("--no-install", action="store_true",
                   help="never install or download; fail if something is missing")
    g.add_argument("--cleanup", action="store_true",
                   help="delete the chunk cache after a verified success")
    args = ap.parse_args(argv)
    args.home = os.path.abspath(os.path.expanduser(args.home))
    if not args.setup_only and not args.images:
        ap.error("images folder is required (or use --setup-only)")
    return args


def main():
    for d in ("/opt/homebrew/bin", "/usr/local/bin"):
        if os.path.isdir(d) and d not in os.environ.get("PATH", "").split(":"):
            os.environ["PATH"] = d + ":" + os.environ.get("PATH", "")
    args = parse_args()
    if os.environ.get("BOOK2AUDIO_VENV") != "1":
        py = setup(args)
        if args.setup_only:
            return 0
        env = dict(os.environ, BOOK2AUDIO_VENV="1", HF_HUB_VERBOSITY="error")
        os.execve(py, [py, os.path.abspath(__file__)] + sys.argv[1:], env)
    return pipeline(args)


if __name__ == "__main__":
    sys.exit(main())
