from voidmaker.agent.codex import (
    REPLY_SCHEMA,
    _dynamic_tool_spec,
    _input_schema,
    _parse_codex_reply,
    _tool_result,
)


class FakeTool:
    name = "set_reminder"
    description = "设置提醒"
    input_schema = {"minutes": float, "content": str}


def test_dynamic_tool_schema_converts_sdk_python_types():
    assert _input_schema(FakeTool.input_schema) == {
        "type": "object",
        "properties": {
            "minutes": {"type": "number"},
            "content": {"type": "string"},
        },
        "required": ["minutes", "content"],
        "additionalProperties": False,
    }
    spec = _dynamic_tool_spec(FakeTool())
    assert spec["name"] == "set_reminder"
    assert spec["inputSchema"]["properties"]["minutes"]["type"] == "number"


def test_tool_result_converts_text_and_image_blocks():
    result = _tool_result(
        {
            "content": [
                {"type": "text", "text": "完成"},
                {"type": "image", "mimeType": "image/png", "data": "YWJj"},
            ]
        }
    )
    assert result == {
        "contentItems": [
            {"type": "inputText", "text": "完成"},
            {"type": "inputImage", "imageUrl": "data:image/png;base64,YWJj"},
        ],
        "success": True,
    }


def test_reply_schema_requires_all_segment_fields():
    assert REPLY_SCHEMA["type"] == "object"
    item = REPLY_SCHEMA["properties"]["segments"]["items"]
    assert set(item["required"]) == {"ja", "zh", "tone", "portrait"}
    assert item["additionalProperties"] is False


def test_wrapped_codex_reply_is_unpacked():
    segments = _parse_codex_reply(
        '{"segments":[{"ja":"はい","zh":"好的","tone":"中性","portrait":"站立待机"}]}'
    )
    assert len(segments) == 1
    assert segments[0].zh == "好的"
