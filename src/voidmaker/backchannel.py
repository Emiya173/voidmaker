"""backchannel 快速接话:规则分类 + 模板轮换(sakura 设计的精简移植)。

只保留 sakura 审计后的高精度规则层(程式化问候闭集 / 无歧义技术报错 /
强吐槽关键词),不引入其 bge 嵌入分类层(本仓库禁止推理栈)。未命中规则
的输入落 fallback 中性 filler——sakura 的闲聊语义分类交给了 probe,我们
没有 probe,靠 fallback 池的"嗯……/我在。"保持低错接风险。

模板来自角色包 character.json 的 backchannel 字段指向的 manifest
(兼容 sakura 格式的子集:templates[].{id,intent,tone,portrait,
variants[].{ja,zh}},未知字段忽略);缺失时用内置 filler。
接话段是纯 UI 临时段:不进聊天历史、不进 LLM 上下文、不占语音队列。
"""

from __future__ import annotations

import json
import random
import re
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

# --- 规则分类(高精度前置快路径,继承 sakura 词表) ---

GREETING_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("greeting_goodnight", ("晚安", "去睡了", "睡觉去", "我先睡", "去休息了")),
    ("greeting_return", ("回来了", "回来啦", "我回啦", "我回来", "到家", "下班", "放学")),
    ("greeting_morning", ("早上好", "早安", "早哇", "我醒了", "起床了")),
    ("greeting_evening", ("晚上好",)),
    ("greeting", ("你好", "您好", "哈喽", "嗨", "hello", "hi", "在吗", "在不在", "在么")),
)
GREETING_MAX_LENGTH = 12
_GREETING_SUFFIX = ("了", "啦", "呀", "啊", "呢", "哦", "喔", "哇", "哈", "咯")
_STRIP_RE = re.compile(r"[\s,，.。!！?？~～…、]+")

ERROR_KEYWORDS = (
    "报错", "出错", "错误", "bug", "Bug", "BUG", "error", "Error",
    "Traceback", "traceback", "exception", "Exception", "闪退",
    "失败", "跑不起来", "运行不了", "无法运行", "无法打开",
)
COMPLAINT_KEYWORDS = (
    "好烦", "很烦", "真烦", "烦死", "烦人", "气死", "讨厌", "受不了",
    "无语", "服了", "恶心", "垃圾", "难用", "卡死", "什么玩意",
)


def classify(text: str) -> str | None:
    """返回意图(greeting 家族 / error / complaint),未命中返回 None。"""
    content = (text or "").strip()
    if not content:
        return None
    stripped = _STRIP_RE.sub("", content).casefold()
    if stripped and len(stripped) <= GREETING_MAX_LENGTH:
        for intent, keywords in GREETING_PATTERNS:
            for kw in keywords:
                if stripped == kw:
                    return intent
                if stripped.startswith(kw) and all(c in _GREETING_SUFFIX for c in stripped[len(kw):]):
                    return intent
    if any(kw in content for kw in ERROR_KEYWORDS):
        return "error"
    if any(kw in content for kw in COMPLAINT_KEYWORDS):
        return "complaint"
    return None


# --- 模板与解析 ---


@dataclass(frozen=True)
class Variant:
    ja: str
    zh: str


@dataclass(frozen=True)
class Template:
    id: str
    intent: str  # "fallback" = 兜底池
    tone: str = "中性"
    portrait: str = ""
    variants: tuple[Variant, ...] = field(default_factory=tuple)


FALLBACK_TEMPLATE = Template(
    id="__fallback__",
    intent="fallback",
    variants=(
        Variant(ja="うん……", zh="嗯……"),
        Variant(ja="あ……", zh="啊……"),
        Variant(ja="えっと……", zh="那个……"),
        Variant(ja="うーん……", zh="唔……"),
        Variant(ja="いるよ。", zh="我在。"),
        Variant(ja="うんうん。", zh="嗯嗯。"),
    ),
)


def load_manifest(path: Path | None) -> tuple[Template, ...]:
    """宽容解析角色包接话清单;缺失/损坏时退内置 filler。"""
    if path is None or not path.is_file():
        return (FALLBACK_TEMPLATE,)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return (FALLBACK_TEMPLATE,)
    templates: list[Template] = []
    for index, entry in enumerate(raw.get("templates") or []):
        if not isinstance(entry, dict):
            continue
        variants = tuple(
            Variant(ja=str(v.get("ja", "")), zh=str(v.get("zh", "")))
            for v in entry.get("variants") or []
            if isinstance(v, dict) and (v.get("ja") or v.get("zh"))
        )
        intent = str(entry.get("intent", "")).strip()
        if not variants or not intent:
            continue
        templates.append(
            Template(
                id=str(entry.get("id") or f"#{index}"),
                intent=intent,
                tone=str(entry.get("tone") or "中性"),
                portrait=str(entry.get("portrait") or ""),
                variants=variants,
            )
        )
    if not any(t.intent == "fallback" for t in templates):
        templates.append(FALLBACK_TEMPLATE)
    return tuple(templates)


RECENT_LIMIT = 3  # 防重复窗口:最近 N 个变体不再选中


class BackchannelResolver:
    """意图 → 模板变体。匹配层级:意图精确 → 意图家族根 → fallback;
    命中层级内防重复随机(继承 sakura resolver 的层级语义,去掉
    emotion/phase 维度——那是 probe 层的输入,规则层给不出)。"""

    def __init__(self, templates: tuple[Template, ...], rng: random.Random | None = None):
        self._templates = templates
        self._rng = rng or random.Random()
        self._recent: deque[tuple[str, int]] = deque(maxlen=RECENT_LIMIT)

    def resolve(self, intent: str | None) -> tuple[Template, Variant] | None:
        tiers: list[list[Template]] = []
        if intent is not None:
            tiers.append([t for t in self._templates if t.intent == intent])
            if "_" in intent:  # greeting_return 无模板时落 greeting,绝不混抽其他子类
                family = intent.split("_", 1)[0]
                tiers.append([t for t in self._templates if t.intent == family])
        tiers.append([t for t in self._templates if t.intent == "fallback"])
        for tier in tiers:
            choice = self._pick(tier)
            if choice is not None:
                return choice
        return None

    def _pick(self, templates: list[Template]) -> tuple[Template, Variant] | None:
        pool = [
            (t, v, (t.id, i))
            for t in templates
            for i, v in enumerate(t.variants)
        ]
        if not pool:
            return None
        fresh = [item for item in pool if item[2] not in self._recent]
        template, variant, key = self._rng.choice(fresh or pool)
        self._recent.append(key)
        return template, variant
