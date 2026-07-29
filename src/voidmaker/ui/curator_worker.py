"""记忆整理后台线程:启动时跑一次,结果下次会话生效。"""

from __future__ import annotations

import asyncio

from PySide6.QtCore import QThread

from ..agent.curator import consolidate_memory
from ..config import AgentConfig


class CuratorWorker(QThread):
    def __init__(self, character_id: str, agent_config: AgentConfig, parent=None):
        super().__init__(parent)
        self._character_id = character_id
        self._agent_config = agent_config

    def run(self) -> None:
        try:
            if asyncio.run(
                consolidate_memory(
                    self._character_id,
                    model=self._agent_config.auxiliary_model,
                    provider=self._agent_config.provider,
                )
            ):
                print("[voidmaker] 记忆整理完成(下次会话生效)", flush=True)
        except Exception as exc:
            print(f"[voidmaker] 记忆整理失败: {exc}", flush=True)
