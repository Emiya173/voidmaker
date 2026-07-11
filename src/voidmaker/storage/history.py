"""聊天历史:JSONL 追加写(沿用 sakura 的简单格式思路)。"""

from __future__ import annotations

import json
import time
from pathlib import Path

from ..config import DATA_DIR


class ChatHistory:
    def __init__(self, character_id: str, base_dir: Path | None = None):
        base = base_dir or (DATA_DIR / "chat_history")
        base.mkdir(parents=True, exist_ok=True)
        self._path = base / f"{character_id}.jsonl"

    @property
    def path(self) -> Path:
        return self._path

    def append(self, role: str, content, **extra) -> None:
        record = {"ts": time.time(), "role": role, "content": content, **extra}
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def tail(self, limit: int = 100) -> list[dict]:
        """读最近 limit 条记录(时间正序)。坏行跳过。"""
        if not self._path.exists():
            return []
        lines = self._path.read_text(encoding="utf-8").splitlines()
        out: list[dict] = []
        for line in lines[-limit:]:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out
