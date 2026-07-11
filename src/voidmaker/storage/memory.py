"""跨会话记忆:每角色一个 markdown 记忆文件(砍掉 sakura 的向量栈)。

两条写入路径:
- remember 工具:对话中模型即时追加一条事实
- 整理子 agent(agent/curator.py):启动时后台把未消化的聊天历史蒸馏进来,
  用 state 文件记录已消化到 history JSONL 的哪个字节偏移
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

from ..config import DATA_DIR


class CharacterMemory:
    def __init__(self, character_id: str, base_dir: Path | None = None):
        base = base_dir or (DATA_DIR / "memory")
        base.mkdir(parents=True, exist_ok=True)
        self._path = base / f"{character_id}.md"
        self._state_path = base / f"{character_id}.state.json"

    @property
    def path(self) -> Path:
        return self._path

    def read(self) -> str:
        return self._path.read_text(encoding="utf-8") if self._path.exists() else ""

    def append(self, content: str) -> None:
        stamp = _dt.date.today().isoformat()
        with self._path.open("a", encoding="utf-8") as f:
            f.write(f"- [{stamp}] {content}\n")

    def replace(self, content: str) -> None:
        self._path.write_text(content.rstrip() + "\n", encoding="utf-8")

    # --- 整理进度(history JSONL 字节偏移) ---

    def consolidated_offset(self) -> int:
        if not self._state_path.exists():
            return 0
        try:
            return int(json.loads(self._state_path.read_text(encoding="utf-8"))["offset"])
        except (ValueError, KeyError, json.JSONDecodeError):
            return 0

    def set_consolidated_offset(self, offset: int) -> None:
        self._state_path.write_text(json.dumps({"offset": offset}), encoding="utf-8")
