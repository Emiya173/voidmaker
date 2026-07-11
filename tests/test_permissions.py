from voidmaker.storage.permissions import PermissionStore


def test_persist_allow_forever_across_instances(tmp_path):
    store = PermissionStore(base_dir=tmp_path)
    assert not store.is_allowed("mcp__pet__open_url")
    store.allow_forever("mcp__pet__open_url")
    # 新实例读同一目录,名单持久
    reloaded = PermissionStore(base_dir=tmp_path)
    assert reloaded.is_allowed("mcp__pet__open_url")
    assert not reloaded.is_allowed("mcp__pet__read_clipboard")


def test_persist_auto_flag(tmp_path):
    store = PermissionStore(base_dir=tmp_path)
    assert store.auto is False
    store.set_auto(True)
    assert PermissionStore(base_dir=tmp_path).auto is True
    store.set_auto(False)
    assert PermissionStore(base_dir=tmp_path).auto is False


def test_corrupt_file_falls_back(tmp_path):
    (tmp_path / "permissions.json").write_text("{坏", encoding="utf-8")
    store = PermissionStore(base_dir=tmp_path)  # 不抛,回落默认
    assert store.auto is False
    assert not store.is_allowed("x")
