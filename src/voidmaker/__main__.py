"""入口。当前只有 --cli 原型:终端里验证「角色卡 → 分段双语回复」链路。"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys

from .agent.client import CharacterAgent
from .agent.curator import consolidate_memory
from .character.loader import scan_characters
from .config import load_config
from .storage.history import ChatHistory
from .storage.memory import CharacterMemory
from .storage.permissions import PermissionStore


async def cli_chat() -> None:
    cfg = load_config()
    cards = scan_characters(cfg.characters_dir)
    card = None
    if cards:
        card = cards.get(cfg.current_character or "") or next(iter(cards.values()))
        print(f"[voidmaker] 角色: {card.display_name} ({card.id})")
    else:
        print("[voidmaker] 未找到角色包(characters/*/character.json),使用默认人格")

    char_id = card.id if card else "default"
    history = ChatHistory(char_id)
    memory = CharacterMemory(char_id)
    permissions = PermissionStore()
    if os.environ.get("VOIDMAKER_AUTO_PERMISSIONS"):
        permissions.set_auto(True)  # CLI 便捷:本次强制 auto 全放行

    loop = asyncio.get_running_loop()
    pending_reminders: list[str] = []

    def schedule_reminder(content: str, delay_s: float) -> None:
        # CLI 的 input() 阻塞事件循环,到点的提醒在下次输入后补触发(仅调试用)
        loop.call_later(delay_s, pending_reminders.append, content)

    async def _consolidate() -> None:
        try:
            if await consolidate_memory(char_id):
                print("[voidmaker] 记忆整理完成(下次会话生效)", flush=True)
        except Exception as exc:
            print(f"[voidmaker] 记忆整理失败: {exc}", flush=True)

    consolidate_task = asyncio.ensure_future(_consolidate())

    async def ask_permission(tool_name: str, tool_input: dict) -> str:
        detail = json.dumps(tool_input, ensure_ascii=False)
        if len(detail) > 200:
            detail = detail[:200] + "…"
        name = tool_name.rsplit("__", 1)[-1]
        answer = await asyncio.to_thread(
            input,
            f"\n[权限] 她想使用 {name},参数 {detail}\n  y=仅这次 / a=一直允许 / 其他=拒绝: ",
        )
        a = answer.strip().lower()
        if a in ("a", "always"):
            return "always"
        if a in ("y", "yes", "once"):
            return "once"
        return "deny"

    def show_notepad(title: str, content: str, fmt: str) -> None:
        # CLI 无 GUI:直接打印到终端(记事窗口在 UI 模式才弹)
        head = f"记事本 · {title}" if title else "记事本"
        print(f"\n┌─ {head} ({fmt}) " + "─" * max(0, 40 - len(head)))
        for line in content.splitlines():
            print(f"│ {line}")
        print("└" + "─" * 50, flush=True)

    homelab_url = cfg.homelab.hub_url if cfg.homelab.enabled else None
    async with CharacterAgent(
        card, cfg.agent, schedule_reminder, memory, ask_permission,
        permissions, homelab_url, show_notepad,
    ) as agent:
        print("输入内容开始对话,Ctrl-D 退出。")
        while True:
            try:
                user_text = input("\n你> ").strip()
            except EOFError:
                print()
                consolidate_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await consolidate_task  # 等子进程收尾,避免循环关闭后 GC 报错
                return
            if not user_text:
                continue
            history.append("user", user_text)
            segments = []
            async for seg in agent.chat(user_text):
                segments.append(seg.model_dump())
                tone = f" [{seg.tone}]" if seg.tone else ""
                if seg.ja:
                    print(f"她>{tone} {seg.ja}")
                print(f"  | {seg.zh}")
            history.append("assistant", segments, **({"usage": agent.last_usage} if agent.last_usage else {}))
            if os.environ.get("VOIDMAKER_SHOW_USAGE") and agent.last_usage:
                u = agent.last_usage
                cr = u.get("cache_read_input_tokens", 0)
                total = u.get("input_tokens", 0) + cr + u.get("cache_creation_input_tokens", 0)
                pct = cr / total * 100 if total else 0
                print(f"  [usage] 未缓存 {u.get('input_tokens', 0)} / 缓存读 {cr} / 命中 {pct:.0f}%")


def main() -> None:
    parser = argparse.ArgumentParser(prog="voidmaker")
    parser.add_argument("--cli", action="store_true", help="终端对话原型(不启动 UI)")
    parser.add_argument("--admin", action="store_true", help="启动本地管理后台(设置/日志/记忆/权限)")
    parser.add_argument("--quit", action="store_true", help="退出正在运行的桌宠实例(快捷键释放用)")
    args = parser.parse_args()

    if args.quit:
        # 纯 socket,无需起 Qt:给运行中的实例发一条 quit
        from .ui.ipc import send_ctl

        ok = send_ctl("quit")
        print("[voidmaker] 已请求退出" if ok else "[voidmaker] 没有运行中的实例", flush=True)
    elif args.admin:
        from .admin.server import run_admin

        addr = os.environ.get("VOIDMAKER_ADMIN_ADDR", "127.0.0.1:8760")
        host, _, port = addr.partition(":")
        run_admin(host or "127.0.0.1", int(port or "8760"))
    elif args.cli:
        asyncio.run(cli_chat())
    else:
        # 延迟导入:--cli 路径不加载 Qt
        from .ui.app import run_app

        sys.exit(run_app(load_config()))


if __name__ == "__main__":
    main()
