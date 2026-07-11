"""工具权限持久化:auto 全放行开关 + "一直允许"的工具名单(跨会话)。

落盘到 ~/.local/share/voidmaker/permissions.json。UI 线程(菜单切 auto)与
agent 线程(命中/写入名单)共享同一个实例;读并发在 GIL 下安全,写加锁。
"""

from __future__ import annotations

import json
import threading

from ..config import DATA_DIR


class PermissionStore:
    def __init__(self, base_dir=None):
        base = base_dir or DATA_DIR
        base.mkdir(parents=True, exist_ok=True)
        self._path = base / "permissions.json"
        self._lock = threading.Lock()
        self._auto = False
        self._allowed: set[str] = set()
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        self._auto = bool(data.get("auto", False))
        self._allowed = set(data.get("allowed", []))

    def _save(self) -> None:
        with self._lock:
            self._path.write_text(
                json.dumps({"auto": self._auto, "allowed": sorted(self._allowed)}, ensure_ascii=False),
                encoding="utf-8",
            )

    @property
    def auto(self) -> bool:
        return self._auto

    def set_auto(self, on: bool) -> None:
        self._auto = bool(on)
        self._save()

    def is_allowed(self, tool_name: str) -> bool:
        return tool_name in self._allowed

    def allowed(self) -> list[str]:
        return sorted(self._allowed)

    def allow_forever(self, tool_name: str) -> None:
        if tool_name not in self._allowed:
            self._allowed.add(tool_name)
            self._save()

    def revoke(self, tool_name: str) -> None:
        if tool_name in self._allowed:
            self._allowed.discard(tool_name)
            self._save()
