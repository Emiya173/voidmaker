import json
import random

from voidmaker.backchannel import (
    FALLBACK_TEMPLATE,
    BackchannelResolver,
    classify,
    load_manifest,
)


def test_classify_greeting_closed_set():
    assert classify("早上好!") == "greeting_morning"
    assert classify("我回来啦~") == "greeting_return"
    assert classify("晚安") == "greeting_goodnight"
    assert classify("Hello!!") == "greeting"
    assert classify("在吗") == "greeting"
    # 长句中包含问候词不算程式化问候
    assert classify("早上好,帮我看看这段代码为什么跑不起来") != "greeting_morning"


def test_classify_error_and_complaint():
    assert classify("又报错了 Traceback 一大堆") == "error"
    assert classify("这破工具真难用,烦死了") == "complaint"
    assert classify("今天天气怎么样") is None
    assert classify("") is None


def test_resolver_tiers_and_rotation():
    rng = random.Random(42)
    resolver = BackchannelResolver((FALLBACK_TEMPLATE,), rng=rng)
    # 未命中意图 → fallback 池
    template, variant = resolver.resolve(None)
    assert template.intent == "fallback"
    # 防重复窗口:连续取样不立即重复
    seen = [resolver.resolve("greeting")[1].zh for _ in range(3)]
    assert len(set(seen)) == 3


def test_resolver_family_fallback(tmp_path):
    manifest = tmp_path / "bc.json"
    manifest.write_text(
        json.dumps(
            {
                "templates": [
                    {
                        "id": "g",
                        "intent": "greeting",
                        "tone": "开心",
                        "portrait": "微笑",
                        "variants": [{"ja": "おはよう", "zh": "早哦"}],
                        "phase": "被忽略的未知字段",
                    },
                    {"id": "坏条目没有variants", "intent": "error"},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    templates = load_manifest(manifest)
    resolver = BackchannelResolver(templates)
    # greeting_morning 无专属模板 → 落家族根 greeting,不落 fallback
    template, variant = resolver.resolve("greeting_morning")
    assert template.id == "g"
    assert variant.zh == "早哦"
    # error 条目无变体被剔除 → 落 fallback
    template, _ = resolver.resolve("error")
    assert template.intent == "fallback"


def test_load_manifest_missing_or_broken(tmp_path):
    assert load_manifest(None) == (FALLBACK_TEMPLATE,)
    broken = tmp_path / "b.json"
    broken.write_text("{坏", encoding="utf-8")
    assert load_manifest(broken) == (FALLBACK_TEMPLATE,)
