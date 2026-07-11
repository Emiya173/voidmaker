"""家庭服务器(homelab)感知:查 homelab-hub 聚合层 + 拓扑参考。

hub 的 /rk 端点零鉴权聚合了媒体机的 Jellyfin/Immich/qBit/追番真实数据,只读、
不做任何控制。拓扑参考是**用户个人基础设施信息**(内网地址/服务清单),不入代码库
——放本地文件 ~/.config/voidmaker/homelab.md,由 load_topology() 读取。
"""

from __future__ import annotations

import httpx

from ..config import CONFIG_PATH

# 拓扑参考放本地文件(不入 git):含内网地址/主机名/服务分布,属个人基础设施信息。
TOPOLOGY_PATH = CONFIG_PATH.parent / "homelab.md"


def load_topology() -> str | None:
    """读用户本地 homelab 拓扑参考(~/.config/voidmaker/homelab.md);没有则 None。"""
    try:
        text = TOPOLOGY_PATH.read_text(encoding="utf-8").strip()
        return text or None
    except OSError:
        return None


def _fmt_bytes(n: float | int | None) -> str:
    if not n:
        return "0 B"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def format_status(payload: dict | None) -> str:
    """把 hub /rk 的 JSON 格式化成可读中文摘要(纯函数)。"""
    if not payload or not payload.get("connected") or not payload.get("data"):
        return "家庭服务器暂时连不上(可能不在家里的网络,或 hub 离线)"
    d = payload["data"]
    age = payload.get("age")
    lines = [f"🏠 家庭服务器(RK3588,数据 {age:.0f}s 前)" if age is not None else "🏠 家庭服务器"]

    jf = d.get("jellyfin") or {}
    if jf.get("ok"):
        line = f"🎬 Jellyfin:{jf.get('movies', 0)} 电影 / {jf.get('series', 0)} 剧集({jf.get('episodes', 0)} 集)"
        for np in jf.get("now_playing") or []:
            state = "已暂停" if np.get("paused") else "播放中"
            line += f"\n   ▶ {np.get('item', '?')}({np.get('pct', 0)}%,{state})"
        lines.append(line)

    im = d.get("immich") or {}
    if im.get("ok"):
        lines.append(
            f"🖼 Immich:{im.get('photos', 0)} 照片 / {im.get('videos', 0)} 视频,"
            f"占用 {_fmt_bytes(im.get('usage_bytes'))}"
        )

    qb = d.get("qbit") or {}
    if qb.get("ok"):
        lines.append(
            f"⬇ qBittorrent:{qb.get('connection', '?')},{qb.get('total', 0)} 个种子"
            f"({qb.get('downloading', 0)} 下载 / {qb.get('seeding', 0)} 做种),"
            f"↓{_fmt_bytes(qb.get('dl_speed'))}/s ↑{_fmt_bytes(qb.get('up_speed'))}/s"
        )

    bg = d.get("bangumi") or {}
    if bg.get("ok"):
        titles = [b.get("title", "?") for b in (bg.get("list") or [])[:5]]
        more = f" 等 {bg.get('subscribed')} 部" if bg.get("subscribed", 0) > len(titles) else ""
        lines.append(f"📺 追番:订阅 {bg.get('subscribed', 0)} 部" + (f"({'、'.join(titles)}{more})" if titles else ""))

    return "\n".join(lines)


async def fetch_status(hub_url: str) -> dict | None:
    """GET {hub_url}/rk。连不上/超时返回 None(优雅降级,不抛)。"""
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(f"{hub_url.rstrip('/')}/rk")
            resp.raise_for_status()
            return resp.json()
    except Exception:
        return None
