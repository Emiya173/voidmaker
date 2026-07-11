from voidmaker.agent.tools import build_pet_server
from voidmaker.perception import homelab
from voidmaker.perception.homelab import format_status, load_topology


def test_format_status_disconnected():
    assert "连不上" in format_status(None)
    assert "连不上" in format_status({"connected": False})


def test_format_status_full():
    payload = {
        "connected": True,
        "age": 58.8,
        "data": {
            "jellyfin": {"ok": True, "movies": 20, "series": 21, "episodes": 330,
                         "now_playing": [{"item": "某剧 S02E13", "pct": 94, "paused": True}]},
            "immich": {"ok": True, "photos": 10020, "videos": 2220, "usage_bytes": 113639204351},
            "qbit": {"ok": True, "connection": "connected", "total": 17,
                     "downloading": 0, "seeding": 0, "dl_speed": 0, "up_speed": 0},
            "bangumi": {"ok": True, "subscribed": 15,
                        "list": [{"title": "番剧甲"}, {"title": "番剧乙"}]},
        },
    }
    text = format_status(payload)
    assert "20 电影 / 21 剧集" in text
    assert "某剧 S02E13" in text and "已暂停" in text
    assert "10020 照片" in text and "GB" in text  # usage 转 GB
    assert "17 个种子" in text
    assert "订阅 15 部" in text and "番剧甲" in text


def test_load_topology_missing_and_present(tmp_path, monkeypatch):
    # 拓扑参考放本地文件(不入 git):没有则 None,有则原样读出
    p = tmp_path / "homelab.md"
    monkeypatch.setattr(homelab, "TOPOLOGY_PATH", p)
    assert load_topology() is None
    p.write_text("我的家庭网络拓扑\n", encoding="utf-8")
    assert load_topology() == "我的家庭网络拓扑"


def test_homelab_tools_registered_only_when_url_given():
    _s, allowed = build_pet_server()
    assert "mcp__pet__homelab_status" not in allowed  # 无 url 不注册
    _s2, allowed2 = build_pet_server(homelab_url="http://x:9201")
    assert "mcp__pet__homelab_status" in allowed2
    assert "mcp__pet__homelab_topology" in allowed2
