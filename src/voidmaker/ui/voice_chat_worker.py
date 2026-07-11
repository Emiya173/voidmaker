"""语音连续对话线程:持续拾音 → VAD 断句 → 转写 → utterance 信号。

半双工:宿主在发送消息/播放分段期间 set_listening(False),期间仍持续
读管道排水(否则 pw-record 背压)但丢弃音频;空闲时恢复拾音。
转写在内部子线程排队执行,不阻塞拾音循环(否则管道 2 秒就会写满)。
"""

from __future__ import annotations

import queue
import threading

from PySide6.QtCore import QThread, Signal

from ..voice.stt import SpeechSegmenter, StreamRecorder, Transcriber

_STOP = object()


class VoiceChatWorker(QThread):
    utterance = Signal(str)  # 识别出的整句
    failed = Signal(str)

    def __init__(self, transcriber: Transcriber, parent=None):
        super().__init__(parent)
        self._transcriber = transcriber
        self._recorder = StreamRecorder()
        self._listening = threading.Event()
        self._stopping = False
        self._jobs: queue.Queue = queue.Queue()

    def set_listening(self, on: bool) -> None:
        if on:
            self._listening.set()
        else:
            self._listening.clear()

    @property
    def listening(self) -> bool:
        return self._listening.is_set()

    def run(self) -> None:
        try:
            self._recorder.start()
        except FileNotFoundError:
            self.failed.emit("pw-record 不可用,连续对话无法启动")
            return
        transcribe_thread = threading.Thread(target=self._transcribe_loop, daemon=True)
        transcribe_thread.start()
        segmenter = SpeechSegmenter()
        was_listening = False
        while True:
            chunk = self._recorder.read_chunk()
            if not chunk:
                if not self._stopping:
                    self.failed.emit("录音流中断,连续对话停止")
                break
            listening = self._listening.is_set()
            if not listening:
                if was_listening:
                    segmenter.reset()  # 暂停瞬间丢弃说到一半的句子
                was_listening = False
                continue  # 持续排水,只是不断句
            was_listening = True
            pcm = segmenter.feed(chunk)
            if pcm is not None:
                self._jobs.put(pcm)
        self._jobs.put(_STOP)
        transcribe_thread.join(timeout=10)

    def _transcribe_loop(self) -> None:
        while True:
            item = self._jobs.get()
            if item is _STOP:
                return
            try:
                text = self._transcriber.transcribe_pcm(item)
            except Exception as exc:
                self.failed.emit(f"语音转写失败: {exc}")
                continue
            if text:
                self.utterance.emit(text)

    def stop(self) -> None:
        self._stopping = True
        self._listening.clear()
        self._recorder.stop()  # 结束子进程使 read_chunk 返回 b''
        self.wait(15000)
