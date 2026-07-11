"""管理后台:存储读接口 + HTTP 服务冒烟(只读端点,不碰真实写)。"""

import json
import threading
import urllib.request

from voidmaker.admin.server import make_server
from voidmaker.storage.history import ChatHistory
from voidmaker.storage.permissions import PermissionStore


def test_history_tail(tmp_path):
    h = ChatHistory("t", base_dir=tmp_path)
    for i in range(5):
        h.append("user", f"msg{i}")
    tail = h.tail(3)
    assert [r["content"] for r in tail] == ["msg2", "msg3", "msg4"]
    # 坏行跳过
    (tmp_path / "t.jsonl").open("a", encoding="utf-8").write("坏行\n")
    assert len(h.tail(100)) == 5  # 坏行不计入


def test_permission_allowed_revoke(tmp_path):
    p = PermissionStore(base_dir=tmp_path)
    p.allow_forever("mcp__pet__open_url")
    p.allow_forever("Bash")
    assert p.allowed() == ["Bash", "mcp__pet__open_url"]
    p.revoke("Bash")
    assert p.allowed() == ["mcp__pet__open_url"]
    assert PermissionStore(base_dir=tmp_path).allowed() == ["mcp__pet__open_url"]  # 持久


def _serve():
    srv = make_server("127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def test_server_serves_page_and_readonly_api():
    srv, port = _serve()
    try:
        base = f"http://127.0.0.1:{port}"
        html = urllib.request.urlopen(base + "/", timeout=3).read().decode()
        assert "VoidMaker 管理后台" in html
        perm = json.loads(urllib.request.urlopen(base + "/api/permissions", timeout=3).read())
        assert "auto" in perm and "allowed" in perm
        hist = json.loads(urllib.request.urlopen(base + "/api/history?limit=5", timeout=3).read())
        assert "records" in hist
    finally:
        srv.shutdown()
