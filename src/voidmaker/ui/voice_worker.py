"""语音后台线程:预合成流水线 + 按指令播放。

与字幕的同步契约(由 PetWindow 驱动):
- prepare(seq, text, tone):入队合成,完成后发 audio_ready(seq, ok)
- play(seq):播放已合成音频,播完发 playback_done(seq)
合成与播放是两个并发协程:播放第 N 段时第 N+1 段可同时在合成。
单段失败只发 audio_ready(seq, False)(该段无语音),不打断对话。

流式模式(cfg.streaming,默认开):audio_ready 在收到首个音频块时就发出,
后续块经 per-seq 队列边收边喂 mpv,首句延迟从整段合成降为首个片段。
合成循环仍串行消费整条流后才处理下一段——对 GPT-SoVITS 单卡服务保持
一次只发一个请求,预取流水线不变。
"""

from __future__ import annotations

import asyncio
import threading

from PySide6.QtCore import QThread, Signal

from ..character.model import CharacterCard
from ..config import TTSConfig
from ..voice.client import TTSClient
from ..voice.tone_refs import load_tone_refs, select_ref

_STOP = object()


async def _drain(queue: asyncio.Queue):
    """把音频块队列变成异步迭代器,读到 None 结束。"""
    while True:
        chunk = await queue.get()
        if chunk is None:
            return
        yield chunk


class VoiceWorker(QThread):
    audio_ready = Signal(int, bool)  # (seq, 是否有可播放音频)
    playback_done = Signal(int)  # seq
    failed = Signal(str)  # 非致命,仅日志

    def __init__(self, card: CharacterCard, cfg: TTSConfig, parent=None):
        super().__init__(parent)
        self._card = card
        self._cfg = cfg
        self._loop: asyncio.AbstractEventLoop | None = None
        self._synth_q: asyncio.Queue | None = None
        self._play_q: asyncio.Queue | None = None
        self._audio: dict[int, bytes] = {}  # 仅 worker 线程访问
        self._streams: dict[int, asyncio.Queue] = {}  # seq → 音频块队列(None = 流结束)
        self._ready = False
        # 事件循环启动前的投递缓冲(开场白在 __init__ 即入队,早于 loop 就绪)
        self._pending_lock = threading.Lock()
        self._pending: list[tuple[str, object]] = []

    def run(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._synth_q = asyncio.Queue()
        self._play_q = asyncio.Queue()
        with self._pending_lock:
            self._ready = True
            for name, item in self._pending:
                (self._synth_q if name == "synth" else self._play_q).put_nowait(item)
            self._pending.clear()

        voice = self._card.voice
        refs = {}
        if voice is not None and voice.tone_refs is not None:
            refs = load_tone_refs(voice.tone_refs, self._card.package_dir)
        if not refs:
            # 语音停用,但仍要消费 prepare 请求并回 audio_ready(False),否则字幕状态机会挂起
            self.failed.emit("角色包缺少语气参考表,语音停用")
            while True:
                item = await self._synth_q.get()
                if item is _STOP:
                    return
                self.audio_ready.emit(item[0], False)

        client = TTSClient(self._cfg)
        try:
            await asyncio.gather(self._synth_loop(client, refs), self._play_loop(client))
        finally:
            await client.aclose()

    async def _synth_loop(self, client: TTSClient, refs: dict) -> None:
        voice = self._card.voice
        weights_ready = False
        while True:
            item = await self._synth_q.get()
            if item is _STOP:
                await self._play_q.put(_STOP)
                return
            seq, text, tone = item
            ref = select_ref(refs, tone)
            if ref is None or not text.strip():
                self.audio_ready.emit(seq, False)
                continue
            try:
                if not weights_ready:
                    await client.set_character_weights(voice.gpt_model, voice.sovits_model)
                    weights_ready = True
            except Exception as exc:
                self.failed.emit(f"TTS 权重加载失败(本段无语音): {exc}")
                self.audio_ready.emit(seq, False)
                continue
            if self._cfg.streaming:
                await self._synth_streaming(client, seq, text, ref)
            else:
                try:
                    self._audio[seq] = await client.synthesize(text, voice.text_lang, ref)
                    self.audio_ready.emit(seq, True)
                except Exception as exc:
                    self.failed.emit(f"TTS 合成失败(本段无语音): {exc}")
                    self.audio_ready.emit(seq, False)

    async def _synth_streaming(self, client: TTSClient, seq: int, text: str, ref) -> None:
        """整条流在此消费完毕(对服务端串行);播放协程经队列并发取块。"""
        chunks: asyncio.Queue = asyncio.Queue()
        started = False
        try:
            async for chunk in client.synthesize_stream(text, self._card.voice.text_lang, ref):
                if not started:
                    started = True
                    self._streams[seq] = chunks
                    self.audio_ready.emit(seq, True)
                chunks.put_nowait(chunk)
        except Exception as exc:
            self.failed.emit(f"TTS 流式合成失败: {exc}")
            if not started:
                self.audio_ready.emit(seq, False)
                return
        chunks.put_nowait(None)

    async def _play_loop(self, client: TTSClient) -> None:
        while True:
            item = await self._play_q.get()
            if item is _STOP:
                return
            seq = item
            stream = self._streams.pop(seq, None)
            audio = self._audio.pop(seq, None)
            try:
                if stream is not None:
                    await client.play_stream(_drain(stream))
                elif audio is not None:
                    await client.play(audio)
            except Exception as exc:
                self.failed.emit(f"语音播放失败: {exc}")
            self.playback_done.emit(seq)

    def _post(self, name: str, item) -> bool:
        with self._pending_lock:
            if not self._ready:
                self._pending.append((name, item))
                return True
        queue = self._synth_q if name == "synth" else self._play_q
        self._loop.call_soon_threadsafe(queue.put_nowait, item)
        return True

    def prepare(self, seq: int, text: str, tone: str | None) -> bool:
        return self._post("synth", (seq, text, tone or ""))

    def play(self, seq: int) -> bool:
        return self._post("play", seq)

    def stop(self) -> None:
        self._post("synth", _STOP)
        self.wait(5000)
