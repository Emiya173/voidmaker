"""语音输入后台线程:录音在主线程控制(子进程,非阻塞),转写在本线程执行。"""

from __future__ import annotations

import queue
from pathlib import Path

from PySide6.QtCore import QThread, Signal

from ..config import STTConfig
from ..voice.stt import Recorder, Transcriber

_STOP = object()


class SttWorker(QThread):
    transcribed = Signal(str)
    failed = Signal(str)

    def __init__(self, cfg: STTConfig, transcriber: Transcriber | None = None, parent=None):
        super().__init__(parent)
        self._cfg = cfg
        self._recorder = Recorder()
        self._transcriber = transcriber  # 可与连续对话 worker 共享(模型只加载一份)
        self._jobs: queue.Queue = queue.Queue()

    @property
    def recording(self) -> bool:
        return self._recorder.recording

    def toggle(self) -> bool:
        """开始/结束录音。返回当前是否在录音。"""
        if self._recorder.recording:
            path = self._recorder.stop()
            if path is not None:
                self._jobs.put(path)
            return False
        try:
            self._recorder.start()
            return True
        except FileNotFoundError:
            self.failed.emit("pw-record 不可用,无法录音")
            return False

    def run(self) -> None:
        transcriber = self._transcriber or Transcriber(self._cfg)
        while True:
            item = self._jobs.get()
            if item is _STOP:
                return
            path: Path = item
            try:
                text = transcriber.transcribe(path)
                if text:
                    self.transcribed.emit(text)
                else:
                    self.failed.emit("没有识别到语音内容")
            except Exception as exc:
                self.failed.emit(f"语音转写失败: {exc}")
            finally:
                path.unlink(missing_ok=True)

    def stop(self) -> None:
        if self._recorder.recording:
            path = self._recorder.stop()
            if path is not None:
                path.unlink(missing_ok=True)
        self._jobs.put(_STOP)
        self.wait(5000)
