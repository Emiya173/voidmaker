"""Codex app-server 后端:持久线程、动态桌宠工具与权限桥接。"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import shutil
import tempfile
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from ..character.model import CharacterCard
from ..config import AgentConfig
from ..storage.memory import CharacterMemory
from ..storage.permissions import PermissionStore
from .reply import ReplySegment, parse_segments
from .tools import ReminderScheduler, build_pet_tools

PermissionHandler = Callable[[str, dict[str, Any]], Any]

REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "ja": {
                        "type": "string",
                        "description": (
                            "实际送入 TTS 的日文语音原文;必须与同段 zh 表达完全相同的信息和语气。"
                        ),
                    },
                    "zh": {
                        "type": "string",
                        "description": (
                            "气泡显示的中文字幕;只能忠实翻译同段 ja,不得单独增加细节、列表或链接。"
                        ),
                    },
                    "tone": {"type": "string"},
                    "portrait": {"type": "string"},
                },
                "required": ["ja", "zh", "tone", "portrait"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["segments"],
    "additionalProperties": False,
}

_JSON_TYPES = {str: "string", int: "integer", float: "number", bool: "boolean"}
# app-server 使用逐行 JSON-RPC;截图工具结果含 base64,单行会轻易超过 asyncio
# 子进程默认的 64 KiB StreamReader 上限。
_APP_SERVER_STREAM_LIMIT = 16 * 1024 * 1024


class CodexAgentError(RuntimeError):
    """Codex app-server 启动或协议错误。"""


async def codex_query(
    prompt: str,
    model: str | None = None,
    reasoning_effort: str | None = None,
    image: bytes | None = None,
    image_suffix: str = ".png",
) -> str:
    """用 ``codex exec`` 完成一次无工具、无持久历史的辅助请求。"""
    executable = shutil.which("codex")
    if executable is None:
        raise CodexAgentError("未找到 codex CLI;请先安装并运行 `codex login`")
    image_path: str | None = None
    if image is not None:
        with tempfile.NamedTemporaryFile(suffix=image_suffix, delete=False) as file:
            file.write(image)
            image_path = file.name
    command = [
        executable,
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--color",
        "never",
    ]
    if model:
        command += ["--model", model]
    if reasoning_effort:
        command += ["--config", f"model_reasoning_effort={json.dumps(reasoning_effort)}"]
    if image_path:
        command += ["--image", image_path]
    command.append("-")
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate(prompt.encode())
    finally:
        if image_path:
            Path(image_path).unlink(missing_ok=True)
    if process.returncode:
        detail = stderr.decode(errors="replace").strip()
        raise CodexAgentError(f"Codex 辅助请求失败: {detail or f'exit {process.returncode}'}")
    return stdout.decode(errors="replace").strip()


def _input_schema(fields: dict[str, type]) -> dict[str, Any]:
    properties = {
        name: {"type": _JSON_TYPES.get(field_type, "string")}
        for name, field_type in fields.items()
    }
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def _dynamic_tool_spec(tool) -> dict[str, Any]:
    return {
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "inputSchema": _input_schema(tool.input_schema),
    }


def _tool_result(result: dict[str, Any]) -> dict[str, Any]:
    items: list[dict[str, str]] = []
    for block in result.get("content", []):
        if block.get("type") == "image":
            mime = block.get("mimeType", "image/jpeg")
            url = f"data:{mime};base64,{block.get('data', '')}"
            items.append({"type": "inputImage", "imageUrl": url})
        else:
            items.append({"type": "inputText", "text": str(block.get("text", ""))})
    return {"contentItems": items, "success": not result.get("is_error", False)}


def _parse_codex_reply(text: str) -> list[ReplySegment]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return parse_segments(text)
    if isinstance(payload, dict) and isinstance(payload.get("segments"), list):
        return parse_segments(json.dumps(payload["segments"], ensure_ascii=False))
    return parse_segments(text)


class CodexCharacterAgent:
    """通过本机 ``codex app-server`` 驱动的角色会话。"""

    def __init__(
        self,
        card: CharacterCard | None,
        cfg: AgentConfig,
        system_prompt: str,
        schedule_reminder: ReminderScheduler | None = None,
        memory: CharacterMemory | None = None,
        permission_handler: PermissionHandler | None = None,
        permissions: PermissionStore | None = None,
        homelab_url: str | None = None,
        show_notepad: Callable[[str, str, str], None] | None = None,
    ):
        del card  # 人格已包含在 system_prompt 中
        tools = build_pet_tools(schedule_reminder, memory, homelab_url, show_notepad)
        self._tools = {tool.name: tool for tool in tools}
        self._cfg = cfg
        self._system_prompt = system_prompt
        self._permission_handler = permission_handler
        self._permissions = permissions
        self._process: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task | None = None
        self._stderr_lines: list[str] = []
        self._request_id = 0
        self._events: list[dict[str, Any]] = []
        self._thread_id: str | None = None
        self.last_usage: dict | None = None

    async def __aenter__(self) -> "CodexCharacterAgent":
        executable = shutil.which("codex")
        if executable is None:
            raise CodexAgentError("未找到 codex CLI;请先安装并运行 `codex login`")
        self._process = await asyncio.create_subprocess_exec(
            executable,
            "app-server",
            "--stdio",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_APP_SERVER_STREAM_LIMIT,
        )
        self._stderr_task = asyncio.create_task(self._drain_stderr(self._process))
        try:
            await self._request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "voidmaker",
                        "title": "VoidMaker",
                        "version": "0.1.0",
                    },
                    "capabilities": {"experimentalApi": True},
                },
            )
            await self._send({"method": "initialized", "params": {}})
            params: dict[str, Any] = {
                "serviceName": "voidmaker",
                "baseInstructions": self._system_prompt,
                "cwd": os.getcwd(),
                "sandbox": "read-only",
                "approvalPolicy": "on-request",
                "ephemeral": True,
                "dynamicTools": [_dynamic_tool_spec(tool) for tool in self._tools.values()],
            }
            if self._cfg.model:
                params["model"] = self._cfg.model
            response = await self._request("thread/start", params)
            self._thread_id = response["thread"]["id"]
        except (KeyError, TypeError) as exc:
            await self.__aexit__()
            raise CodexAgentError(f"Codex 未返回 thread id: {response!r}") from exc
        except BaseException:
            await self.__aexit__()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        if process.stdin is not None:
            process.stdin.close()
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
        with contextlib.suppress(asyncio.TimeoutError, ProcessLookupError):
            await asyncio.wait_for(process.wait(), timeout=2)
        if process.returncode is None:
            process.kill()
            await process.wait()
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stderr_task

    async def _drain_stderr(self, process: asyncio.subprocess.Process) -> None:
        assert process.stderr is not None
        while line := await process.stderr.readline():
            self._stderr_lines.append(line.decode(errors="replace").rstrip())
            self._stderr_lines = self._stderr_lines[-20:]

    def _failure_detail(self) -> str:
        detail = "\n".join(self._stderr_lines).strip()
        return f": {detail}" if detail else ""

    async def _send(self, message: dict[str, Any]) -> None:
        if self._process is None or self._process.stdin is None:
            raise CodexAgentError("Codex app-server 尚未启动")
        payload = json.dumps(message, ensure_ascii=False).encode() + b"\n"
        self._process.stdin.write(payload)
        await self._process.stdin.drain()

    async def _read(self) -> dict[str, Any]:
        if self._process is None or self._process.stdout is None:
            raise CodexAgentError("Codex app-server 尚未启动")
        while line := await self._process.stdout.readline():
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
        raise CodexAgentError(f"Codex app-server 意外退出{self._failure_detail()}")

    async def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._request_id += 1
        request_id = self._request_id
        await self._send({"method": method, "id": request_id, "params": params})
        while True:
            message = await self._read()
            if message.get("id") == request_id and ("result" in message or "error" in message):
                if "error" in message:
                    error = message["error"]
                    text = error.get("message", repr(error)) if isinstance(error, dict) else str(error)
                    raise CodexAgentError(f"Codex {method} 失败: {text}")
                return message.get("result") or {}
            if "method" in message and "id" in message:
                await self._handle_server_request(message)
            elif "method" in message:
                self._events.append(message)

    async def _permission_choice(self, name: str, arguments: dict[str, Any]) -> str:
        if self._permissions is not None:
            if self._permissions.auto or self._permissions.is_allowed(name):
                return "always"
        if self._permission_handler is None:
            return "deny"
        choice = await self._permission_handler(name, arguments)
        if choice == "always" and self._permissions is not None:
            self._permissions.allow_forever(name)
        return choice

    async def _handle_server_request(self, message: dict[str, Any]) -> None:
        method = message["method"]
        params = message.get("params") or {}
        request_id = message["id"]
        if method == "item/tool/call":
            result = await self._call_dynamic_tool(params)
        elif method == "item/commandExecution/requestApproval":
            choice = await self._permission_choice(
                "codex__command",
                {"command": params.get("command"), "cwd": params.get("cwd"), "reason": params.get("reason")},
            )
            decision = "acceptForSession" if choice == "always" else "accept" if choice == "once" else "decline"
            result = {"decision": decision}
        elif method == "item/fileChange/requestApproval":
            choice = await self._permission_choice("codex__file_change", params)
            decision = "acceptForSession" if choice == "always" else "accept" if choice == "once" else "decline"
            result = {"decision": decision}
        elif method == "item/tool/requestUserInput":
            # 桌宠 UI 当前只有权限选择器,不在一轮中嵌入普通问答表单。
            result = {"answers": {}}
        else:
            await self._send(
                {
                    "id": request_id,
                    "error": {"code": -32601, "message": f"VoidMaker 不支持 server request: {method}"},
                }
            )
            return
        await self._send({"id": request_id, "result": result})

    async def _call_dynamic_tool(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("tool", ""))
        tool = self._tools.get(name)
        if tool is None:
            return {
                "contentItems": [{"type": "inputText", "text": f"未知工具: {name}"}],
                "success": False,
            }
        arguments = params.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        from .client import needs_confirmation

        permission_name = f"mcp__pet__{name}"
        if needs_confirmation(permission_name):
            choice = await self._permission_choice(permission_name, arguments)
            if choice not in ("once", "always"):
                return {
                    "contentItems": [{"type": "inputText", "text": "用户拒绝了此操作"}],
                    "success": False,
                }
        try:
            result = await tool.handler(arguments)
        except Exception as exc:
            result = {
                "content": [{"type": "text", "text": f"工具执行失败: {exc}"}],
                "is_error": True,
            }
        return _tool_result(result)

    async def chat(
        self,
        user_text: str,
        image: bytes | None = None,
        image_mime: str = "image/png",
    ) -> AsyncIterator[ReplySegment]:
        if self._thread_id is None:
            raise CodexAgentError("Codex thread 尚未启动")
        inputs: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
        if image is not None:
            data = base64.standard_b64encode(image).decode()
            inputs.insert(0, {"type": "image", "url": f"data:{image_mime};base64,{data}"})
        params: dict[str, Any] = {
            "threadId": self._thread_id,
            "input": inputs,
            "outputSchema": REPLY_SCHEMA,
        }
        if self._cfg.reasoning_effort:
            params["effort"] = self._cfg.reasoning_effort
        response = await self._request("turn/start", params)
        turn_id = (response.get("turn") or {}).get("id")
        final_messages: list[str] = []
        unknown_messages: list[str] = []
        turn_error: str | None = None
        while True:
            if self._events:
                message = self._events.pop(0)
            else:
                message = await self._read()
            if "method" in message and "id" in message:
                await self._handle_server_request(message)
                continue
            method = message.get("method")
            params = message.get("params") or {}
            if params.get("turnId") not in (None, turn_id):
                continue
            if method == "item/completed":
                item = params.get("item") or {}
                if item.get("type") == "agentMessage":
                    if item.get("phase") == "final_answer":
                        final_messages.append(item.get("text", ""))
                    elif item.get("phase") is None:
                        unknown_messages.append(item.get("text", ""))
            elif method == "thread/tokenUsage/updated":
                usage = (params.get("tokenUsage") or {}).get("last")
                if isinstance(usage, dict):
                    self.last_usage = {
                        "input_tokens": usage.get("inputTokens", 0),
                        "cache_read_input_tokens": usage.get("cachedInputTokens", 0),
                        "output_tokens": usage.get("outputTokens", 0),
                    }
            elif method == "error" and not params.get("willRetry", False):
                error = params.get("error") or {}
                turn_error = error.get("message", str(error))
            elif method == "turn/completed":
                status = (params.get("turn") or {}).get("status")
                if status == "failed" or turn_error:
                    raise CodexAgentError(turn_error or "Codex turn 执行失败")
                break
        text = "".join(final_messages or unknown_messages)
        for segment in _parse_codex_reply(text):
            yield segment
