"""屏幕截图(Wayland/niri):grim 全屏,或 grim -g "$(slurp)" 框选。

给模型看的截图用 JPEG + 缩放:全屏 PNG(双屏可达数 MB)base64 后会撑爆
agent SDK 的传输缓冲,且高分辨率对理解屏幕内容无增益(API 侧也会再缩)。
若 grim 不可用,改走 xdg-desktop-portal 的 Screenshot 接口。
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

SCALE = "0.5"  # 双屏 5440 宽 → 2720,JPEG q80 后 base64 远低于缓冲上限
JPEG_QUALITY = "80"


async def capture_fullscreen() -> Path:
    """全屏 JPEG 截图(缩放,所有显示器),用于喂给模型。"""
    path = Path(tempfile.mkstemp(suffix=".jpg", prefix="voidmaker-screen-")[1])
    proc = await asyncio.create_subprocess_exec(
        "grim", "-t", "jpeg", "-q", JPEG_QUALITY, "-s", SCALE, str(path)
    )
    code = await proc.wait()
    if code != 0:
        path.unlink(missing_ok=True)
        raise RuntimeError(f"grim 退出码 {code} — 检查合成器是否支持 screencopy,或改用 xdg-desktop-portal")
    return path


async def _focused_output_name() -> str | None:
    """niri 当前聚焦的显示器名(如 DP-2);拿不到返回 None。"""
    import json

    try:
        proc = await asyncio.create_subprocess_exec(
            "niri", "msg", "-j", "focused-output",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return None
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return None
    name = data.get("name") if isinstance(data, dict) else None
    return name or None


async def capture_focused_output() -> Path:
    """只截当前聚焦的那一块显示器(自动收窄范围,省 token)。

    拿不到聚焦显示器名(非 niri / 出错)时回退全屏,保证总能出图。
    """
    name = await _focused_output_name()
    if name is None:
        return await capture_fullscreen()
    path = Path(tempfile.mkstemp(suffix=".jpg", prefix="voidmaker-screen-")[1])
    proc = await asyncio.create_subprocess_exec(
        "grim", "-o", name, "-t", "jpeg", "-q", JPEG_QUALITY, "-s", SCALE, str(path)
    )
    if await proc.wait() != 0:
        path.unlink(missing_ok=True)
        return await capture_fullscreen()  # 单屏失败也回退全屏
    return path


async def _run_ok(*args: str) -> bool:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
        )
    except FileNotFoundError:
        return False
    return await proc.wait() == 0


async def _clipboard_text() -> bytes | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            "wl-paste", "--no-newline", "--type", "text",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return None
    out, _ = await proc.communicate()
    return out if proc.returncode == 0 and out else None


async def _restore_clipboard(saved: bytes | None) -> None:
    """把截图从剪贴板抹掉:有原内容就写回,没有就清空。"""
    if saved:
        try:
            proc = await asyncio.create_subprocess_exec(
                "wl-copy", stdin=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
            )
        except FileNotFoundError:
            return
        await proc.communicate(saved)
    else:
        await _run_ok("wl-copy", "--clear")


async def _cliphist_drop_top_image() -> None:
    """尽力从 cliphist 历史删掉刚存进去的那张截图(顶端条目若是 png 二进制)。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "cliphist", "list", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
    except FileNotFoundError:
        return
    out, _ = await proc.communicate()
    if proc.returncode != 0 or not out:
        return
    top = out.split(b"\n", 1)[0]
    if b"binary data" in top and b"png" in top:
        try:
            dproc = await asyncio.create_subprocess_exec(
                "cliphist", "delete", stdin=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError:
            return
        await dproc.communicate(top)


async def capture_focused_window() -> Path:
    """只截当前聚焦的那个窗口(最细范围)。

    niri screenshot-window 只能把图放进剪贴板,故:截图 → 读剪贴板 PNG →
    恢复原剪贴板(抹掉截图)+ 尽力清 cliphist 历史。任一步失败回退聚焦单屏。
    """
    saved: bytes | None = None
    clobbered = False
    try:
        saved = await _clipboard_text()
        if not await _run_ok(
            "niri", "msg", "action", "screenshot-window", "--write-to-disk", "false"
        ):
            raise RuntimeError("screenshot-window 失败")
        clobbered = True
        await asyncio.sleep(0.4)  # 等合成器把图写进剪贴板(实测需一帧以上)
        proc = await asyncio.create_subprocess_exec(
            "wl-paste", "--type", "image/png",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        png, _ = await proc.communicate()
        if proc.returncode != 0 or not png:
            raise RuntimeError("剪贴板未取到窗口截图")
        path = Path(tempfile.mkstemp(suffix=".png", prefix="voidmaker-win-")[1])
        path.write_bytes(png)
        return path
    except Exception:
        return await capture_focused_output()
    finally:
        if clobbered:  # 只在真的动过剪贴板时才清理,避免无谓 churn
            await _cliphist_drop_top_image()
            await _restore_clipboard(saved)


async def capture_region() -> Path:
    """框选截图(原始分辨率 PNG,供用户主动发送)。"""
    slurp = await asyncio.create_subprocess_exec("slurp", stdout=asyncio.subprocess.PIPE)
    out, _ = await slurp.communicate()
    if slurp.returncode != 0:
        raise RuntimeError("slurp 取消或失败")
    geometry = out.decode().strip()
    path = Path(tempfile.mkstemp(suffix=".png", prefix="voidmaker-region-")[1])
    proc = await asyncio.create_subprocess_exec("grim", "-g", geometry, str(path))
    if await proc.wait() != 0:
        path.unlink(missing_ok=True)
        raise RuntimeError("grim 区域截图失败")
    return path
