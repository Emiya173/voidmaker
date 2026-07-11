# 角色包目录

`<id>/character.json` + 立绘/语音资源,兼容 sakura 的角色包格式。

- 从 [sakura Releases](https://github.com/Rvosy/sakura/releases) 下载 `.char` 后解压到本目录。
- **角色内容不入 git**(立绘/语音为二创资产,版权不在 MIT 覆盖范围内),.gitignore 已排除。
- 加载逻辑:`src/voidmaker/character/loader.py`;字段与 sakura 的
  `app/config/character_loader.py` 对齐,拿到实际包后补全 schema。

最小 character.json 示例:

```json
{
  "id": "example",
  "display_name": "示例角色",
  "persona": "系统提示主体……",
  "tones": ["中性", "开心"],
  "portrait": {
    "default": "portraits/default.png",
    "expressions": { "开心": "portraits/happy.png" }
  }
}
```
