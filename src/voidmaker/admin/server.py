"""本地管理后台:浏览器里查/改设置、看聊天日志、查/编辑记忆与权限。

标准库 http.server(零依赖),只绑 127.0.0.1——能改配置/记忆/权限,属敏感操作,
绝不暴露到网络。读写直接落到 config.yaml / 记忆 md / 历史 jsonl / permissions.json。
启动:python -m voidmaker --admin(VOIDMAKER_ADMIN_ADDR=host:port 可覆盖地址)。
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import yaml

from ..character.loader import scan_characters
from ..config import CONFIG_PATH, AppConfig, load_config
from ..storage.history import ChatHistory
from ..storage.memory import CharacterMemory
from ..storage.permissions import PermissionStore

PAGE = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VoidMaker 管理后台</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 system-ui,sans-serif;background:#16161e;color:#d8d8e0}
header{padding:14px 20px;background:#1e1e2a;border-bottom:1px solid #33334a;font-weight:600}
nav{display:flex;gap:4px;padding:8px 16px;background:#1a1a24;border-bottom:1px solid #2a2a3a}
nav button{background:none;border:none;color:#9a9ab0;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:14px}
nav button.on{background:#2e2e42;color:#e8e8f0}
main{padding:20px;max-width:900px;margin:0 auto}
section{display:none}section.on{display:block}
textarea{width:100%;min-height:340px;background:#12121a;color:#d8d8e0;border:1px solid #33334a;border-radius:8px;padding:12px;font:13px/1.5 monospace;resize:vertical}
button.act{background:#5b5be0;color:#fff;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:14px}
button.act:hover{background:#6e6ef0}
.msg{margin-left:12px;color:#8a8;font-size:13px}
.msg.err{color:#e77}
.rec{border:1px solid #2a2a3a;border-radius:8px;padding:8px 12px;margin:6px 0;background:#1a1a24}
.rec .role{font-weight:600}.rec .role.user{color:#7ab7ff}.rec .role.assistant{color:#ff9ecb}
.rec .ts{color:#666;font-size:12px;float:right}
.rec .use{color:#7a8;font-size:11px;margin-top:4px}
.row{display:flex;align-items:center;gap:10px;margin:8px 0}
.tool{font-family:monospace;background:#12121a;padding:4px 10px;border-radius:6px}
label{user-select:none}
</style></head><body>
<header>VoidMaker 管理后台 <span id="who" style="color:#888;font-weight:400"></span></header>
<nav>
 <button data-t="set" class="on">设置</button>
 <button data-t="mem">记忆</button>
 <button data-t="perm">权限</button>
 <button data-t="log">日志</button>
</nav>
<main>
 <section id="set" class="on">
  <p>直接编辑 config.yaml(保存前会校验;字段见 src/voidmaker/config.py)。</p>
  <textarea id="cfg"></textarea>
  <div class="row"><button class="act" onclick="saveCfg()">保存设置</button><span class="msg" id="cfgmsg"></span></div>
 </section>
 <section id="mem">
  <p>她对用户的长期记忆(跨会话注入系统提示)。可直接编辑保存。</p>
  <textarea id="memt"></textarea>
  <div class="row"><button class="act" onclick="saveMem()">保存记忆</button><span class="msg" id="memmsg"></span></div>
 </section>
 <section id="perm">
  <div class="row"><label><input type="checkbox" id="auto" onchange="setAuto()"> 自动允许所有工具(不再确认)</label></div>
  <p>已"一直允许"的工具(点移除即撤销):</p>
  <div id="allowed"></div>
 </section>
 <section id="log">
  <div class="row">最近 <input id="lim" type="number" value="50" min="1" max="1000" style="width:70px;background:#12121a;color:#ddd;border:1px solid #33334a;border-radius:6px;padding:4px"> 条
   <button class="act" onclick="loadLog()">刷新</button></div>
  <div id="hist"></div>
 </section>
</main>
<script>
const $=s=>document.querySelector(s), api=(u,o)=>fetch(u,o).then(r=>r.json());
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{
 document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));
 document.querySelectorAll('section').forEach(x=>x.classList.remove('on'));
 b.classList.add('on'); $('#'+b.dataset.t).classList.add('on');
});
async function init(){
 const c=await api('/api/config'); $('#cfg').value=c.yaml||''; $('#who').textContent='· 角色 '+c.char_id;
 window.charName=c.char_name||'她';
 $('#memt').value=(await api('/api/memory')).text||'';
 loadPerm(); loadLog();
}
function segText(s){ return (s&&(s.zh||s.ja))||''; }
async function saveCfg(){
 const r=await api('/api/config',{method:'POST',body:JSON.stringify({yaml:$('#cfg').value})});
 const m=$('#cfgmsg'); m.textContent=r.ok?'已保存(重启生效)':('错误: '+r.error); m.className='msg'+(r.ok?'':' err');
}
async function saveMem(){
 const r=await api('/api/memory',{method:'POST',body:JSON.stringify({text:$('#memt').value})});
 const m=$('#memmsg'); m.textContent=r.ok?'已保存':'错误'; m.className='msg'+(r.ok?'':' err');
}
async function loadPerm(){
 const p=await api('/api/permissions'); $('#auto').checked=p.auto;
 $('#allowed').innerHTML=p.allowed.length?p.allowed.map(t=>
  `<div class="row"><span class="tool">${t.replace('mcp__pet__','')}</span><button class="act" onclick="revoke('${t}')">移除</button></div>`).join(''):'<p style="color:#888">(暂无)</p>';
}
async function setAuto(){ await api('/api/permissions',{method:'POST',body:JSON.stringify({auto:$('#auto').checked})}); }
async function revoke(t){ await api('/api/permissions',{method:'POST',body:JSON.stringify({revoke:t})}); loadPerm(); }
async function loadLog(){
 const r=await api('/api/history?limit='+($('#lim').value||50));
 $('#hist').innerHTML=r.records.slice().reverse().map(x=>{
  let c=x.content;
  if(Array.isArray(c)) c=c.map(segText).filter(Boolean).join(' / ');
  else if(c&&typeof c==='object') c=segText(c);
  const name=x.role==='user'?'你':(window.charName||'她');
  const d=new Date(x.ts*1000).toLocaleString();
  let use='';
  if(x.usage){const u=x.usage, cr=u.cache_read_input_tokens||0, cc=u.cache_creation_input_tokens||0,
    inp=u.input_tokens||0, tot=inp+cr+cc, pct=tot?Math.round(cr/tot*100):0;
    use=`<div class="use">缓存命中 ${pct}% · 未缓存 ${inp} tok · 读 ${cr} · 写 ${cc}</div>`;}
  return `<div class="rec"><span class="ts">${d}</span><span class="role ${x.role}">${name}</span>: ${(''+c).replace(/</g,'&lt;')}${use}</div>`;
 }).join('')||'<p style="color:#888">(暂无历史)</p>';
}
init();
</script></body></html>"""


def _resolve_char(cfg: AppConfig) -> tuple[str, str]:
    cards = scan_characters(cfg.characters_dir)
    if cards:
        card = cards.get(cfg.current_character or "") or next(iter(cards.values()))
        return card.id, (card.display_name or card.id)
    return "default", "她"


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    @property
    def _cid(self) -> str:
        return self.server.char_id  # type: ignore[attr-defined]

    @property
    def _cname(self) -> str:
        return self.server.char_name  # type: ignore[attr-defined]

    def _send(self, body: bytes, ctype: str, code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8", code)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {}

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        if u.path == "/":
            return self._send(PAGE.encode(), "text/html; charset=utf-8")
        if u.path == "/api/config":
            text = CONFIG_PATH.read_text(encoding="utf-8") if CONFIG_PATH.exists() else ""
            return self._json({"yaml": text, "char_id": self._cid, "char_name": self._cname})
        if u.path == "/api/memory":
            return self._json({"text": CharacterMemory(self._cid).read()})
        if u.path == "/api/history":
            limit = int((parse_qs(u.query).get("limit", ["100"])[0]) or 100)
            return self._json({"records": ChatHistory(self._cid).tail(max(1, min(limit, 1000)))})
        if u.path == "/api/permissions":
            p = PermissionStore()
            return self._json({"auto": p.auto, "allowed": p.allowed()})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        data = self._read_json()
        if path == "/api/config":
            text = str(data.get("yaml", ""))
            try:
                AppConfig.model_validate(yaml.safe_load(text) or {})  # 校验后才写
            except Exception as exc:
                return self._json({"ok": False, "error": str(exc)[:300]}, 400)
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            CONFIG_PATH.write_text(text, encoding="utf-8")
            return self._json({"ok": True})
        if path == "/api/memory":
            CharacterMemory(self._cid).replace(str(data.get("text", "")))
            return self._json({"ok": True})
        if path == "/api/permissions":
            p = PermissionStore()
            if "auto" in data:
                p.set_auto(bool(data["auto"]))
            if data.get("revoke"):
                p.revoke(str(data["revoke"]))
            return self._json({"ok": True, "auto": p.auto, "allowed": p.allowed()})
        return self._json({"error": "not found"}, 404)


def make_server(host: str, port: int) -> ThreadingHTTPServer:
    cfg = load_config()
    srv = ThreadingHTTPServer((host, port), _Handler)
    srv.char_id, srv.char_name = _resolve_char(cfg)  # type: ignore[attr-defined]
    return srv


def run_admin(host: str = "127.0.0.1", port: int = 8760) -> None:
    srv = make_server(host, port)
    print(
        f"[voidmaker] 管理后台: http://{host}:{port}  "
        f"(角色 {srv.char_id}, Ctrl-C 退出)",  # type: ignore[attr-defined]
        flush=True,
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()
