# 本地角色素材

本目录仅保留这份说明进入 Git。`.char`、导入后的角色目录、PMX、贴图、录音和权重均被忽略。
运行时格式是 TypeScript 应用的 `character.json`，不加载旧 Python loader 或 `card.md`。

导入 Shinsekai 包：

```sh
nix develop
pnpm character:import characters/七海千秋.char characters/chiaki chiaki http://127.0.0.1:9881/tts
```

目标目录必须不存在。导入工具仅读取配置和素材，将第一张 WebP 立绘转成 PNG，
提取 GPT/SoVITS 两份权重与参考音频，记录来源 SHA-256。其余表情仍可从原包中选配。
权重由仓库外的 GPT-SoVITS 服务加载，Host 不执行角色包代码。

Host 默认读取 `~/.local/share/voidmaker/characters`，本目录不会自动注册。
完整配置、3D 转换与启动步骤见 [角色文档](../docs/CHARACTERS.md) 和
[七海千秋接入记录](../docs/CHIAKI_CHARACTER_RESEARCH.md)。
