"""Jarvis voice daemon for Claude Code.

Always-on pipeline: microphone -> openWakeWord ("hey jarvis") -> record until
silence -> faster-whisper transcription -> `claude -p` headless dispatch ->
spoken reply via Windows SAPI.

Run with --check for a one-shot self-test (no listening loop).
Logs to jarvis.log next to this script; safe to run under pythonw.exe.
"""

import argparse
import glob
import json
import logging
import logging.handlers
import os
import re
import subprocess
import sys
import time

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "jarvis_config.json")
LOG_PATH = os.path.join(SCRIPT_DIR, "jarvis.log")

SAMPLE_RATE = 16000
CHUNK = 1280  # 80 ms frames, the size openWakeWord expects

DEFAULT_CONFIG = {
    "wake_threshold": 0.4,
    "silence_rms": 350,
    "silence_seconds": 0.8,
    "max_command_seconds": 8,
    "whisper_model": "base.en",
    "permission_mode": "acceptEdits",
    "workdir": SCRIPT_DIR,
    "speak_replies": True,
    "max_speak_chars": 400,
    "input_device": None,
    "tts_voice": "en-GB-RyanNeural",
    "tts_rate": "-12%",
    "tts_pitch": "-6Hz",
    "ack_text": "Right away, sir.",
    "followup_window_seconds": 30,
    # Usage guards: keep voice commands from eating the Claude plan quota.
    "daily_claude_limit": 60,
    "session_idle_reset_seconds": 600,
    "voice_system_prompt": (
        "You are answering through a voice interface. Reply in at most two "
        "short conversational sentences unless the user explicitly asks for "
        "detail. No markdown, no code blocks, no lists. "
        "To control apps or media, run exactly this pre-approved command: "
        "powershell -ExecutionPolicy Bypass -File "
        "{APPS} <action> [arg] "
        "with one of these actions: launch-chrome [url], launch-whatsapp, "
        "launch-spotify, launch-steam, launch-discord, launch-claude, "
        "close-chrome, close-whatsapp, close-spotify, close-steam, "
        "close-discord, close-claude, "
        "open-url <url>, play-pause, next-track, previous-track, volume-up, "
        "volume-down, mute, sleep (puts the PC to sleep), status, "
        "list-games, launch-game <appid>, "
        "close-game <appid>. For Steam games: use list-games to see "
        "installed games with appids, then launch-game or close-game with "
        "the appid. To close a game use ONLY close-game <appid> — never "
        "close-steam, which kills the whole Steam client and every running "
        "game; use close-steam only when the user explicitly asks to close "
        "Steam itself. claude means the Claude Desktop app. "
        "Use it for requests like 'open Spotify', "
        "'pause the music', 'next song', or 'open youtube.com'. "
        "When an action succeeds, reply with exactly: OK. Nothing more — "
        "the user hears a completion tone instead of speech. Only reply "
        "with words if the action failed or the user asked a question."
    ),
}

log = logging.getLogger("jarvis")


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    else:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    # {APPS} keeps the config portable across machines/usernames.
    apps = os.path.join(SCRIPT_DIR, "jarvis_apps.ps1").replace("\\", "/")
    cfg["voice_system_prompt"] = cfg["voice_system_prompt"].replace(
        "{APPS}", apps)
    return cfg


def find_claude():
    """The desktop app bundles the CLI under a per-version folder; pick the newest."""
    candidates = glob.glob(
        os.path.join(os.environ["APPDATA"], "Claude", "claude-code", "*", "claude.exe")
    )
    for extra in ("claude.exe", "claude.cmd"):
        w = shutil_which(extra)
        if w:
            candidates.append(w)
    if not candidates:
        raise FileNotFoundError("claude.exe not found; install Claude Code CLI")

    def version_key(p):
        m = re.search(r"[\\/](\d+)\.(\d+)\.(\d+)[\\/]", p)
        return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)

    return max(candidates, key=version_key)


def shutil_which(name):
    from shutil import which
    return which(name)


def beep(freq, ms):
    try:
        import winsound
        winsound.Beep(freq, ms)
    except Exception:
        pass


class Speaker:
    """Neural Edge TTS (JARVIS-style British voice) with offline SAPI fallback."""

    def __init__(self, cfg):
        self.enabled = cfg["speak_replies"]
        self.voice = cfg["tts_voice"]
        self.rate = cfg["tts_rate"]
        self.pitch = cfg["tts_pitch"]

    def say(self, text):
        if not self.enabled or not text:
            return
        try:
            self._say_edge(text)
        except Exception as e:
            log.warning("edge-tts failed (%s); falling back to SAPI", e)
            self._say_sapi(text)

    def synth_to_file(self, text, path):
        import asyncio

        import edge_tts

        async def gen():
            await edge_tts.Communicate(
                text, self.voice, rate=self.rate, pitch=self.pitch
            ).save(path)

        asyncio.run(gen())

    def play_file(self, path, wait=True):
        import pygame

        if not pygame.mixer.get_init():
            pygame.mixer.init()
        pygame.mixer.music.load(path)
        pygame.mixer.music.play()
        if wait:
            while pygame.mixer.music.get_busy():
                time.sleep(0.1)
            pygame.mixer.music.unload()

    def _say_edge(self, text):
        import tempfile

        mp3 = os.path.join(tempfile.gettempdir(), "jarvis_tts.mp3")
        self.synth_to_file(text, mp3)
        self.play_file(mp3, wait=True)

    def wait_idle(self):
        import pygame

        if pygame.mixer.get_init():
            while pygame.mixer.music.get_busy():
                time.sleep(0.05)

    def speak_sentence(self, text):
        """Streamed speech: synth overlaps the previous sentence's playback."""
        if not self.enabled:
            return
        text = clean_for_speech(text, 1000)
        if not text:
            return
        try:
            import tempfile

            self._idx = getattr(self, "_idx", 0) + 1
            path = os.path.join(tempfile.gettempdir(),
                                f"jarvis_tts_{self._idx % 2}.mp3")
            self.synth_to_file(text, path)
            self.wait_idle()
            self.play_file(path, wait=False)
        except Exception as e:
            log.warning("Streamed TTS failed (%s); falling back", e)
            self._say_sapi(text)

    def _say_sapi(self, text):
        try:
            # Fresh engine per utterance: pyttsx3's SAPI loop is unreliable when reused.
            import pyttsx3
            engine = pyttsx3.init()
            engine.setProperty("rate", 150)
            engine.say(text)
            engine.runAndWait()
            engine.stop()
        except Exception as e:
            log.warning("TTS failed: %s", e)


def clean_for_speech(text, max_chars):
    text = re.sub(r"```.*?```", " (code omitted) ", text, flags=re.S)
    text = re.sub(r"[`*_#>|]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_chars:
        cut = text[:max_chars]
        cut = cut.rsplit(". ", 1)[0] if ". " in cut else cut
        text = cut + ". Full answer is in the log."
    return text


class ClaudeDispatcher:
    """One long-lived `claude -p` stream-json session.

    Keeping the process alive avoids ~2-4s of CLI spawn + session reload per
    command, keeps conversation context, and lets us stream text deltas so
    speech can start on the first finished sentence.
    """

    IDLE_TIMEOUT = 180  # max seconds between stream events before giving up

    def __init__(self, cfg):
        self.exe = find_claude()
        self.cfg = cfg
        self.proc = None
        self.lines = None  # queue fed by the stdout reader thread
        self.last_used = 0.0
        self.stderr_file = open(os.path.join(SCRIPT_DIR, "claude_stderr.log"),
                                "a", encoding="utf-8")
        log.info("Using claude CLI: %s", self.exe)
        self._ensure()

    def _ensure(self):
        if self.proc is not None and self.proc.poll() is None:
            # Long-idle sessions keep resending a growing transcript on every
            # turn; recycle so context (and token cost) restarts from zero.
            idle = time.time() - self.last_used
            if self.last_used and idle > self.cfg["session_idle_reset_seconds"]:
                log.info("Recycling claude session after %.0fs idle", idle)
                self._kill()
            else:
                return
        import queue
        import threading

        # Re-resolve on every respawn: the CLI auto-updates and deletes the
        # old version folder, invalidating a cached path mid-session.
        if not os.path.exists(self.exe):
            self.exe = find_claude()
            log.info("claude CLI moved; now using %s", self.exe)

        cmd = [self.exe, "-p",
               "--input-format", "stream-json",
               "--output-format", "stream-json",
               "--include-partial-messages", "--verbose",
               "--permission-mode", self.cfg["permission_mode"],
               "--append-system-prompt", self.cfg["voice_system_prompt"]]
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.stderr_file, text=True, encoding="utf-8",
            errors="replace", cwd=self.cfg["workdir"],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        self.lines = queue.Queue()

        def pump(proc, q):
            for line in proc.stdout:
                q.put(line)
            q.put(None)  # EOF sentinel

        threading.Thread(target=pump, args=(self.proc, self.lines),
                         daemon=True).start()
        log.info("Started persistent claude session (pid %s)", self.proc.pid)

    def _kill(self):
        if self.proc is not None:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None

    def send(self, prompt, on_sentence=None):
        """Send one user turn; stream completed sentences to on_sentence.

        Returns the full reply text (also fully delivered via on_sentence).
        """
        import queue

        for attempt in (1, 2):
            self._ensure()
            msg = json.dumps({"type": "user",
                              "message": {"role": "user", "content": prompt}})
            try:
                self.proc.stdin.write(msg + "\n")
                self.proc.stdin.flush()
            except OSError as e:
                log.warning("claude stdin write failed (%s); restarting", e)
                self._kill()
                continue

            self.last_used = time.time()
            log.info("Dispatching to claude: %r", prompt)
            buffer = ""
            spoken = []
            while True:
                try:
                    line = self.lines.get(timeout=self.IDLE_TIMEOUT)
                except queue.Empty:
                    log.error("claude stream stalled >%ss; restarting",
                              self.IDLE_TIMEOUT)
                    self._kill()
                    return "Claude Code stalled. Please try again."
                if line is None:  # process exited
                    log.warning("claude session ended (attempt %d)", attempt)
                    self._kill()
                    if buffer.strip() or spoken:
                        # Partial answer already spoken; don't repeat the turn.
                        return ("".join(spoken) + buffer).strip()
                    break  # retry once with a fresh process
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "stream_event":
                    delta = ev.get("event", {}).get("delta", {})
                    if delta.get("type") == "text_delta":
                        buffer += delta.get("text", "")
                        buffer = self._emit(buffer, spoken, on_sentence)
                elif ev.get("type") == "result":
                    if buffer.strip() and on_sentence:
                        on_sentence(buffer.strip())
                    spoken.append(buffer)
                    full = ev.get("result") or "".join(spoken)
                    log.info("claude reply (%d chars): %s",
                             len(full), full[:2000])
                    return full.strip()
        return "Claude Code returned an error. Check the log."

    @staticmethod
    def _emit(buffer, spoken, on_sentence):
        """Fire on_sentence for each completed sentence; return the remainder."""
        parts = re.split(r"(?<=[.!?])\s+", buffer)
        for sentence in parts[:-1]:
            if sentence.strip():
                spoken.append(sentence + " ")
                if on_sentence:
                    on_sentence(sentence.strip())
        return parts[-1]


APP_WORDS = {
    "chrome": "chrome", "google chrome": "chrome", "the browser": "chrome",
    "whatsapp": "whatsapp",
    "spotify": "spotify",
    "steam": "steam",
    "discord": "discord",
    "claude": "claude", "claude desktop": "claude", "cloud": "claude",
}


def match_local_action(text):
    """Map simple app/media commands to a jarvis_apps.ps1 action.

    Returns the action string, or None to fall through to Claude.
    Skips the ~8-10s Claude round-trip for the commands people fire the most.
    """
    t = re.sub(r"[^a-z ]", " ", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"^(please |can you |could you )+", "", t)
    t = re.sub(r"( please)+$", "", t)

    tail = r"( the)?( music| song| track| playback| spotify)?$"
    if re.fullmatch(r"(pause|stop)" + tail, t):
        return "play-pause"
    if re.fullmatch(r"(play|resume|unpause|continue)" + tail, t):
        return "play-pause"
    if re.fullmatch(r"(next|skip)( the)?( track| song)?", t):
        return "next-track"
    if re.fullmatch(r"(previous|last|back)( track| song)?", t):
        return "previous-track"
    if re.fullmatch(r"((turn )?(the )?volume up|turn it up|louder)", t):
        return "volume-up"
    if re.fullmatch(r"((turn )?(the )?volume down|turn it down|quieter)", t):
        return "volume-down"
    if re.fullmatch(r"(mute|unmute)( it| the sound| the volume)?", t):
        return "mute"
    if re.fullmatch(
            r"(go to sleep|sleep|good night|goodnight"
            r"|(put|send)( the)?( pc| computer)?( in| into| to)? sleep)"
            r"( mode)?", t):
        return "sleep"

    m = re.fullmatch(r"(open|launch|start)( up)?( the)? (?P<app>[a-z ]+?)( app)?", t)
    if m and m.group("app") in APP_WORDS:
        return "launch-" + APP_WORDS[m.group("app")]
    m = re.fullmatch(r"(close|quit|exit|kill)( the)? (?P<app>[a-z ]+?)( app)?", t)
    if m and m.group("app") in APP_WORDS:
        return "close-" + APP_WORDS[m.group("app")]
    return None


_steam_cache = {"games": {}, "at": 0.0}


def steam_catalog():
    """Installed Steam games as {name: appid}, from local appmanifest files."""
    if time.time() - _steam_cache["at"] < 300:
        return _steam_cache["games"]
    import winreg
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam")
        root = winreg.QueryValueEx(key, "SteamPath")[0]
    except OSError:
        root = r"C:\Program Files (x86)\Steam"
    root = root.replace("/", "\\")
    libs = {os.path.join(root, "steamapps").lower()}
    vdf = os.path.join(root, "steamapps", "libraryfolders.vdf")
    if os.path.exists(vdf):
        with open(vdf, encoding="utf-8", errors="replace") as f:
            for p in re.findall(r'"path"\s+"([^"]+)"', f.read()):
                libs.add(os.path.join(p.replace("\\\\", "\\"), "steamapps").lower())
    games = {}
    for lib in libs:
        for acf in glob.glob(os.path.join(lib, "appmanifest_*.acf")):
            try:
                with open(acf, encoding="utf-8", errors="replace") as f:
                    txt = f.read()
            except OSError:
                continue
            appid = re.search(r'"appid"\s+"(\d+)"', txt)
            name = re.search(r'"name"\s+"([^"]+)"', txt)
            if not appid or not name:
                continue
            if re.search(r"Steamworks Common|Redistributab|Runtime|Proton",
                         name.group(1)):
                continue
            games[name.group(1)] = appid.group(1)
    _steam_cache.update(games=games, at=time.time())
    return games


def match_game_command(text):
    """(action, appid, name) for 'open/close <steam game>' phrases, else None."""
    import difflib

    t = re.sub(r"[^a-z0-9 ]", " ", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    m = re.fullmatch(
        r"(?P<verb>open|launch|start|play|run|close|quit|exit|kill|stop)"
        r"( up)?( the)?( game)? (?P<name>[a-z0-9 ]{2,50}?)( game)?", t)
    if not m:
        return None
    games = steam_catalog()
    if not games:
        return None

    def norm(s):
        return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()

    phrase = norm(m.group("name"))
    best, best_score = None, 0.0
    for name, appid in games.items():
        n = norm(name)
        score = difflib.SequenceMatcher(None, phrase, n).ratio()
        if phrase and (phrase in n or n in phrase):
            score = max(score, 0.85)
        if score > best_score:
            best, best_score = (name, appid), score
    if best is None or best_score < 0.65:
        return None
    action = ("close-game" if m.group("verb") in
              ("close", "quit", "exit", "kill", "stop") else "launch-game")
    return action, best[1], best[0]


class Listener:
    def __init__(self, cfg):
        import sounddevice as sd
        from openwakeword.model import Model

        self.cfg = cfg
        self.sd = sd
        self.oww = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
        log.info("Wake-word model loaded")

        from faster_whisper import WhisperModel
        self.whisper = WhisperModel(cfg["whisper_model"], device="cpu",
                                    compute_type="int8")
        log.info("Whisper model '%s' loaded", cfg["whisper_model"])

        self.dispatcher = ClaudeDispatcher(cfg)
        self.speaker = Speaker(cfg)
        self.noise_floor = None
        self.last_done = 0.0  # when the previous command finished
        self.usage_path = os.path.join(SCRIPT_DIR, "usage.json")
        self.ack_path = self._prepare_ack()

    def _prepare_ack(self):
        """Pre-synthesize the acknowledgment line so it plays instantly."""
        cfg = self.cfg
        if not cfg["speak_replies"] or not cfg["ack_text"]:
            return None
        import hashlib
        key = hashlib.md5(
            f"{cfg['tts_voice']}|{cfg['tts_rate']}|{cfg['tts_pitch']}|"
            f"{cfg['ack_text']}".encode()
        ).hexdigest()[:8]
        path = os.path.join(SCRIPT_DIR, f"ack_{key}.mp3")
        if not os.path.exists(path):
            try:
                self.speaker.synth_to_file(cfg["ack_text"], path)
            except Exception as e:
                log.warning("Could not pre-synthesize ack: %s", e)
                return None
        return path

    def open_stream(self):
        return self.sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="int16",
            blocksize=CHUNK, device=self.cfg["input_device"],
        )

    def run(self):
        from collections import deque

        log.info("Listening for 'hey jarvis'...")
        preroll = deque(maxlen=8)  # ~0.64s so words right after the wake word survive
        with self.open_stream() as stream:
            while True:
                frame, _ = stream.read(CHUNK)
                frame = frame[:, 0]
                preroll.append(frame)
                rms = float(np.sqrt(np.mean(frame.astype(np.float64) ** 2)))
                # Ambient-noise EMA (~1.6s time constant) so music or fan hum
                # doesn't defeat end-of-speech detection during recording.
                self.noise_floor = (rms if self.noise_floor is None
                                    else 0.95 * self.noise_floor + 0.05 * rms)
                score = self.oww.predict(frame)["hey_jarvis"]
                if 0.25 <= score < self.cfg["wake_threshold"]:
                    if time.time() - getattr(self, "_last_miss", 0) > 3:
                        self._last_miss = time.time()
                        log.info("Wake near-miss (score %.2f, below %.2f)",
                                 score, self.cfg["wake_threshold"])
                if score >= self.cfg["wake_threshold"]:
                    log.info("Wake word detected (score %.2f)", score)
                    beep(880, 150)
                    audio = self.record_command(stream, list(preroll))
                    preroll.clear()
                    self.oww.reset()
                    self.handle_command(audio)
                    log.info("Listening for 'hey jarvis'...")

    def record_command(self, stream, preroll=None):
        """Record until silence_seconds of quiet after speech, or max length."""
        cfg = self.cfg
        frames = list(preroll) if preroll else []
        silent_needed = int(cfg["silence_seconds"] * SAMPLE_RATE / CHUNK)
        max_frames = int(cfg["max_command_seconds"] * SAMPLE_RATE / CHUNK)
        # Relative to ambient noise, not absolute: quiet mics never crossed
        # the old fixed threshold, so recording always ran to the max cap.
        floor = self.noise_floor or 50
        threshold = min(max(150.0, floor * 2.5), 4000.0)
        no_speech_frames = int(3.0 * SAMPLE_RATE / CHUNK)
        log.info("Recording (silence threshold %.0f, noise floor %.0f)",
                 threshold, floor)
        silent_run = 0
        heard_speech = False
        for i in range(max_frames):
            frame, _ = stream.read(CHUNK)
            frame = frame[:, 0]
            frames.append(frame)
            rms = float(np.sqrt(np.mean(frame.astype(np.float64) ** 2)))
            if rms >= threshold:
                heard_speech = True
                silent_run = 0
            else:
                silent_run += 1
                if heard_speech and silent_run >= silent_needed:
                    break
                if not heard_speech and i >= no_speech_frames:
                    break  # wake word fired but nothing followed
        return np.concatenate(frames) if frames else np.array([], dtype=np.int16)

    def claude_budget_left(self):
        """Remaining Claude dispatches today (local actions don't count)."""
        import datetime
        today = datetime.date.today().isoformat()
        used = 0
        try:
            with open(self.usage_path, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("date") == today:
                used = int(data.get("claude_calls", 0))
        except (OSError, ValueError):
            pass
        return self.cfg["daily_claude_limit"] - used, today, used

    def record_claude_call(self, today, used):
        try:
            with open(self.usage_path, "w", encoding="utf-8") as f:
                json.dump({"date": today, "claude_calls": used + 1}, f)
        except OSError as e:
            log.warning("Could not write usage file: %s", e)

    def run_app_action(self, action, arg=None):
        cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
               "-File", os.path.join(SCRIPT_DIR, "jarvis_apps.ps1"), action]
        if arg:
            cmd.append(arg)
        try:
            r = subprocess.run(cmd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=30,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            return (r.stdout or r.stderr or "").strip() or "no output"
        except Exception as e:
            return f"error: {e}"

    def transcribe(self, audio):
        if audio.size < SAMPLE_RATE // 2:
            return ""
        samples = audio.astype(np.float32) / 32768.0
        # initial_prompt biases decoding so the wake-phrase tail in the
        # pre-roll comes out as "Jarvis" (strippable) instead of garble
        # like "love is" / "always".
        segments, _ = self.whisper.transcribe(samples, language="en",
                                              vad_filter=True,
                                              initial_prompt="Hey Jarvis,")
        return " ".join(s.text.strip() for s in segments).strip()

    def handle_command(self, audio):
        text = self.transcribe(audio)
        # Pre-roll may reintroduce the wake phrase, and Whisper decorates or
        # garbles it ("Welcome to Jarvis,", "this is Jarvis", "love is").
        # If "jarvis" appears near the start, drop everything through it.
        text = re.sub(r"^[^.!?]{0,25}?\bjarvis\b[,.!?]*\s*", "", text,
                      flags=re.I).strip()
        text = re.sub(
            r"^\W*((hey|hi|a|the)\W+)?(jervis|jarvus|gervais|travis"
            r"|love is|always)\W+",
            "", text, flags=re.I).strip()
        # Common verb mishears.
        text = re.sub(r"^clothes\b", "close", text, flags=re.I)
        log.info("Transcribed: %r", text)
        if len(re.sub(r"[^a-zA-Z]", "", text)) < 3:
            beep(440, 120)  # heard nothing usable
            return
        if re.fullmatch(r"(never mind|nevermind|cancel|stop)[.!]?",
                        text.strip(), re.I):
            beep(440, 120)
            return

        action = match_local_action(text)
        if action:
            beep(1200, 100)
            out = self.run_app_action(action)
            log.info("Local action %s -> %s", action, out.strip()[:200])
            beep(880, 120)
            self.last_done = time.time()
            return

        game = match_game_command(text)
        if game:
            action, appid, name = game
            beep(1200, 100)
            out = self.run_app_action(action, appid)
            log.info("Game action %s %s (%s) -> %s", action, appid, name,
                     out.strip()[:200])
            beep(880, 120)
            self.last_done = time.time()
            return
        # Everything below this point costs plan quota; local actions above
        # are free and stay unaffected by the daily cap.
        left, today, used = self.claude_budget_left()
        if left <= 0:
            log.warning("Daily Claude limit (%d) reached; refusing %r",
                        self.cfg["daily_claude_limit"], text)
            beep(440, 120)
            beep(440, 200)
            self.speaker.say("Daily command limit reached, sir. App and media "
                             "controls still work.")
            self.last_done = time.time()
            return
        if left <= 5:
            log.info("Claude budget low: %d of %d left", left,
                     self.cfg["daily_claude_limit"])

        # Spoken ack only on the first command of a conversation; commands
        # within the follow-up window get a quick beep and immediate work.
        followup = (time.time() - self.last_done
                    < self.cfg["followup_window_seconds"])
        if self.ack_path and not followup:
            try:
                # Non-blocking: "Right away, sir" plays while Claude works.
                self.speaker.play_file(self.ack_path, wait=False)
            except Exception:
                beep(1200, 100)
        else:
            beep(1200, 100)  # acknowledged, working

        spoken_chars = [0]

        def is_trivial(t):
            return t.strip().rstrip(".!?").lower() in ("ok", "okay", "done")

        def on_sentence(s):
            if is_trivial(s):
                return  # bare action confirmation -> completion beep only
            if spoken_chars[0] >= self.cfg["max_speak_chars"]:
                return  # cap reached; rest of the reply stays in the log
            spoken_chars[0] += len(s)
            self.speaker.speak_sentence(s)

        # Claude has no clock and can't run commands to get one; give it the
        # real local time so "what time is it" never guesses or tries a tool.
        import datetime
        now = datetime.datetime.now().strftime("%A, %B %d, %Y, %I:%M %p")
        prompt = f"(Context: user's local time is {now}.) {text}"
        self.record_claude_call(today, used)
        reply = self.dispatcher.send(
            prompt, on_sentence=on_sentence if self.cfg["speak_replies"] else None)
        if spoken_chars[0] == 0 and reply and not is_trivial(reply):
            # Nothing streamed (error path or speech disabled+re-enabled).
            self.speaker.say(clean_for_speech(reply, self.cfg["max_speak_chars"]))
        self.speaker.wait_idle()
        beep(880, 120)  # done
        self.last_done = time.time()


def setup_logging():
    handler = logging.handlers.RotatingFileHandler(
        LOG_PATH, maxBytes=2_000_000, backupCount=2, encoding="utf-8")
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    handler.setFormatter(fmt)
    log.addHandler(handler)
    if sys.stdout is not None:
        con = logging.StreamHandler(sys.stdout)
        con.setFormatter(fmt)
        log.addHandler(con)
    log.setLevel(logging.INFO)


def self_check(cfg):
    import sounddevice as sd
    ok = True
    try:
        dev = sd.query_devices(kind="input")
        log.info("CHECK mic: default input device: %s", dev["name"])
    except Exception as e:
        log.error("CHECK mic FAILED: %s", e)
        ok = False
    try:
        exe = find_claude()
        v = subprocess.run([exe, "--version"], capture_output=True, text=True,
                           timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
        log.info("CHECK claude: %s -> %s", exe, v.stdout.strip())
    except Exception as e:
        log.error("CHECK claude FAILED: %s", e)
        ok = False
    try:
        listener = Listener(cfg)
        listener.dispatcher._kill()
        log.info("CHECK models: wake-word + whisper loaded OK")
    except Exception as e:
        log.error("CHECK models FAILED: %s", e)
        ok = False
    log.info("CHECK result: %s", "PASS" if ok else "FAIL")
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="verify mic, models, and claude CLI, then exit")
    args = parser.parse_args()

    setup_logging()
    cfg = load_config()

    if args.check:
        sys.exit(0 if self_check(cfg) else 1)

    # Single-instance guard: hold a localhost port for the process lifetime.
    # The watchdog task blindly relaunches us every 5 minutes; duplicates
    # fail this bind and exit silently.
    import socket
    guard = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        guard.bind(("127.0.0.1", 51799))
        guard.listen(1)
    except OSError:
        return  # another instance is already listening

    while True:  # outer loop survives audio-device hiccups (sleep/unplug)
        try:
            Listener(cfg).run()
        except KeyboardInterrupt:
            log.info("Stopped by user")
            return
        except Exception:
            log.exception("Listener crashed; restarting in 10s")
            time.sleep(10)


if __name__ == "__main__":
    main()
