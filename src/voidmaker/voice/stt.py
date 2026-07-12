"""语音输入:pw-record 录音 + faster-whisper(CPU) 转写。

faster-whisper 走 CTranslate2 纯 CPU 推理(int8),不引入 torch/GPU 栈;
模型懒加载(首次使用时自动从 HF 下载)。录音经 PipeWire,16k 单声道。
配置 stt.server_url 时优先调 whisper.cpp HTTP 服务(~/dev/whisper-cpp,
Vulkan/GPU),失败自动回退本地。

连续对话用 StreamRecorder(raw PCM 流)+ SpeechSegmenter(能量 VAD 断句):
噪声底自适应,静音超时切句,过短语音按噪声丢弃。
"""

from __future__ import annotations

import math
import signal
import subprocess
import tempfile
import threading
import wave
from array import array
from collections import deque
from pathlib import Path

from ..config import STTConfig

SAMPLE_RATE = 16000
CHUNK_MS = 30
BYTES_PER_CHUNK = SAMPLE_RATE * 2 * CHUNK_MS // 1000  # s16 单声道


class Recorder:
    """pw-record 子进程录音。start() → stop() 返回 wav 路径。"""

    def __init__(self):
        self._proc: subprocess.Popen | None = None
        self._path: Path | None = None

    @property
    def recording(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self) -> None:
        if self.recording:
            return
        self._path = Path(tempfile.mkstemp(suffix=".wav", prefix="voidmaker-stt-")[1])
        self._proc = subprocess.Popen(
            [
                "pw-record",
                "--format", "s16",
                "--rate", "16000",
                "--channels", "1",
                str(self._path),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def stop(self) -> Path | None:
        if self._proc is None:
            return None
        if self._proc.poll() is None:
            self._proc.send_signal(signal.SIGINT)  # pw-record 收 SIGINT 才会写完 wav 头
            try:
                self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None
        path, self._path = self._path, None
        return path


class StreamRecorder:
    """pw-record --raw 持续拾音,read_chunk() 阻塞读一个 30ms PCM 块。

    stop() 可从其他线程调用:结束子进程使 read_chunk 返回 b''(流结束)。
    """

    def __init__(self):
        self._proc: subprocess.Popen | None = None

    def start(self) -> None:
        self._proc = subprocess.Popen(
            [
                "pw-record",
                "--format", "s16",
                "--rate", str(SAMPLE_RATE),
                "--channels", "1",
                "--raw", "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

    def read_chunk(self) -> bytes:
        if self._proc is None or self._proc.stdout is None:
            return b""
        return self._proc.stdout.read(BYTES_PER_CHUNK)

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()


def _rms(chunk: bytes) -> float:
    samples = array("h", chunk)
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


class SpeechSegmenter:
    """能量 VAD 断句:按块喂 PCM,说完一句(静音超时)返回整句字节。纯逻辑可单测。

    - 噪声底 EMA 只在非语音期更新,阈值 = max(下限, 噪声底×3)
    - 结束判定用 0.6× 阈值迟滞,避免句中喘息误切
    - 有效语音块不足 min_speech_ms 的段按噪声丢弃
    """

    def __init__(
        self,
        *,
        silence_ms: int = 800,
        min_speech_ms: int = 250,
        pre_roll_ms: int = 300,
        max_utterance_ms: int = 30_000,
    ):
        self._silence_chunks = max(1, silence_ms // CHUNK_MS)
        self._min_speech_chunks = max(1, min_speech_ms // CHUNK_MS)
        self._pre_roll: deque[bytes] = deque(maxlen=max(1, pre_roll_ms // CHUNK_MS))
        self._max_chunks = max_utterance_ms // CHUNK_MS
        self._noise_floor = 200.0
        self._in_speech = False
        self._buffer: list[bytes] = []
        self._silence_run = 0
        self._speech_chunks = 0

    def reset(self) -> None:
        """丢弃进行中的语句(暂停拾音时调用,pipe 仍在排水)。"""
        self._in_speech = False
        self._buffer = []
        self._pre_roll.clear()
        self._silence_run = 0
        self._speech_chunks = 0

    def feed(self, chunk: bytes) -> bytes | None:
        rms = _rms(chunk)
        threshold = max(300.0, self._noise_floor * 3.0)
        if not self._in_speech:
            if rms >= threshold:
                self._in_speech = True
                self._buffer = [*self._pre_roll, chunk]
                self._speech_chunks = 1
                self._silence_run = 0
            else:
                self._noise_floor += 0.05 * (rms - self._noise_floor)
                self._pre_roll.append(chunk)
            return None
        self._buffer.append(chunk)
        if rms >= threshold * 0.6:
            self._silence_run = 0
            self._speech_chunks += 1
        else:
            self._silence_run += 1
        if self._silence_run >= self._silence_chunks or len(self._buffer) >= self._max_chunks:
            return self._finish()
        return None

    def _finish(self) -> bytes | None:
        buffer = self._buffer
        speech_chunks = self._speech_chunks
        self.reset()
        if speech_chunks < self._min_speech_chunks:
            return None
        return b"".join(buffer)


class Transcriber:
    """转写:server_url 配置时优先 whisper.cpp HTTP 服务(GPU),否则/失败时
    进程内 faster-whisper(懒加载,首次调用较慢:下载+加载模型)。

    可在多个 worker 间共享(内部加锁),避免模型加载两份。
    """

    def __init__(self, cfg: STTConfig):
        self._cfg = cfg
        self._model = None
        self._lock = threading.Lock()

    def transcribe(self, wav_path: Path) -> str:
        if self._cfg.server_url:
            text = self._transcribe_server(wav_path)
            if text is not None:
                return text
        return self._transcribe_local(wav_path)

    def _transcribe_server(self, wav_path: Path) -> str | None:
        """whisper-server 的 /inference 契约:multipart 上传,JSON 回文本。
        连接失败/超时/坏响应返回 None,由调用方回退本地。"""
        import httpx

        url = self._cfg.server_url.rstrip("/") + "/inference"
        data = {"response_format": "json"}
        if self._cfg.language:
            data["language"] = self._cfg.language
        try:
            with wav_path.open("rb") as f:
                resp = httpx.post(
                    url,
                    files={"file": (wav_path.name, f, "audio/wav")},
                    data=data,
                    timeout=30.0,
                )
            resp.raise_for_status()
            return str(resp.json().get("text", "")).strip()
        except (httpx.HTTPError, ValueError):
            return None

    def _transcribe_local(self, wav_path: Path) -> str:
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(self._cfg.model, device="cpu", compute_type="int8")
            segments, _info = self._model.transcribe(
                str(wav_path),
                language=self._cfg.language,
                vad_filter=True,
            )
            return "".join(seg.text for seg in segments).strip()

    def transcribe_pcm(self, pcm: bytes) -> str:
        """16k 单声道 s16 原始 PCM → 文本(经临时 wav)。"""
        path = Path(tempfile.mkstemp(suffix=".wav", prefix="voidmaker-vad-")[1])
        try:
            with wave.open(str(path), "wb") as f:
                f.setnchannels(1)
                f.setsampwidth(2)
                f.setframerate(SAMPLE_RATE)
                f.writeframes(pcm)
            return self.transcribe(path)
        finally:
            path.unlink(missing_ok=True)
