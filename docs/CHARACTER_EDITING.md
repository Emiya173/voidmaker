# Blender 修模与 Qt 检查

本流程把几何编辑与 Qt 材质分开：Blender 编辑顶点、UV、自定义法线和顶点表情；
Qt 继续使用原 PMX 的 Toon、描边、透明度与 `look.json` 外观配置。
`.blend` 保留原骨骼和完整表情，运行时仍只使用静态站姿、口型、眨眼和可选常态眼睑。
这是保留拓扑的局部修模流程，不包含重拓扑、MMD 物理、MME 节点或骨骼动画转换。

## 建立零修改基准

```sh
nix develop .#character
pnpm character:roundtrip /path/to/source.pmx /path/to/new-baseline \
  --pose relaxed --look /path/to/look.json
```

普通开发环境不安装 Blender；`character` 环境从现有 `flake.lock` 固定 Blender，
另外固定 MMD Tools 4.5.14 的源码哈希与随附 OpenCC 依赖，不改用户插件目录。
本机版本为 Blender 5.1.1。首次进入此环境会下载 Blender。

输出目录必须不存在。`look.json` 可省略；往返流程拒绝其中的 `geometry`，避免再叠加程序形变。
`relaxed` 站姿在导出后由同一个 PMX 转换器烘焙，Blender 工程保持原始静止姿态。
主要产物如下：

| 文件 | 用途 |
| --- | --- |
| `baseline.blend` | 原始 PMX 的可编辑工程，仅初次导入时生成 |
| `blender.gltf` / `blender.bin` | 几何交换文件，不承担正式材质转换 |
| `blender-toolchain.json` | 来源、版本、适配器/二进制哈希及法线传递策略 |
| `audit.json` | 顶点身份、拓扑、材质分配、法线、UV、描边权重及表情误差 |
| `before/avatar.json` / `after/avatar.json` | 使用相同配置的 Qt 对照模型 |
| `blender.log` / `failure.txt` | 导出日志与失败原因；失败产物保留供排查 |

glTF 可以因法线/UV 边界拆分顶点，审计按原始顶点 ID 和**有方向的三角形**核对，
不以顶点顺序或总数相同作为正确依据。零修改超出容差时命令失败，不自动安装到角色目录。

## 实际 Qt 检查

```sh
pnpm character:inspect /path/to/new-baseline/before/avatar.json \
  /path/to/new-baseline/after/avatar.json --reference /path/to/portrait.png

# 自动保存固定机位、各自渲染图、对照图和 pixels.json；目录必须不存在
pnpm character:inspect /path/to/new-baseline/before/avatar.json \
  /path/to/new-baseline/after/avatar.json --reference /path/to/portrait.png \
  --capture /path/to/new-captures
```

检查台直接加载正式 `Character3D.qml` 与着色器，双方共用基准模型的取景尺寸。
可同步调整旋转、俯仰、倍率、上下取景、口型与眨眼，切换正式材质、原贴图、纯色、线框、法线、描边和转台。
自动截图包含正面、左右 65°、头顶、四种诊断视图、张嘴、闭眼及 280×490 逻辑像素桌面尺寸。
报告保存有效像素数量与逐通道差异；空画面会报错。实际输出像素尺寸受当前屏幕缩放影响，比较双方一致。
像素误差只能诊断转换差异；风格、穿插、发束层次和发饰贴合仍需看图验收。

需要实际图形会话，当前使用 Wayland/OpenGL。检查台是普通窗口，由 niri 管理位置，
不访问 Host、数据库、模型服务或麦克风。每次转换使用新目录并重新打开检查台，避免资源缓存混入旧产物。

## 修改与复查

```sh
# 在 character 环境打开基准，另存为 working.blend 后编辑
blender --factory-startup --disable-autoexec /path/to/new-baseline/baseline.blend

pnpm character:roundtrip /path/to/source.pmx /path/to/new-candidate \
  --blend /path/to/working.blend --allow-edits \
  --pose relaxed --look /path/to/look.json

pnpm character:inspect /path/to/new-baseline/after/avatar.json \
  /path/to/new-candidate/after/avatar.json --reference /path/to/portrait.png
```

工程提供 `edit:<原材质名>` 顶点组，可选中头发、发饰、外套等区域，再用连通选择定位单束头发。
每次只改明确的部件，保存独立候选；头顶必须检查俯视、侧面和线框，发饰必须检查侧面贴合。
造型变化同时核对各个 shape key：需要保持表情位移的顶点，应对 Basis 和相关表情施加同样变化，
避免只移动 Basis 后，眨眼或常态眼睑把部件拉回旧位置。

保留单个网格、材质槽顺序、三角形连接、UV 和 `_PMX_ID`、`_PMX_EDGE`、`_VM_BASE_POSITION`、
`_VM_BASE_NORMAL` 属性；不合并顶点、重拓扑或拆成多个物体。工作在编辑模式，避免残留物体变换。
未应用的几何修改器会被拒绝，骨架固定在 REST；改变拓扑或材质分配即使指定 `--allow-edits` 也会失败。
`--allow-edits` 只允许数值差异，不把审计的 `passed:false` 改成 true，仍输出完整变化指标。
它不是视觉通过标志，转换工具也不会自动部署候选。

Blender 的材质节点不作为 Qt 外观依据。贴图另存新文件，通过 `look.textures` 引用；
材质颜色、阴影强度与描边使用 `look.materials`。保持原 UV 布局，并分别看原贴图和正式材质输出。

## 法线保真策略与已知边界

真实七海模型的直接 glTF 导出出现法线量化误差，折叠眼线三角形还有明显的法线变化。
仅启用“导出法线”不足以保真，因此采用显式的浮点法线通道 `_VM_NORMAL`：

- 导入时保存位置与逐角法线快照。
- 顶点及相邻面未移动、逐角法线也未修改的区域，传递原 PMX 的法线，包括隐藏表情中的零法线。
- 编辑过的邻域或法线使用 Blender 当前逐角法线，避免覆盖有意的修模结果。
- 审计同时报告原始 `NORMAL` 导出误差与最终传递误差；修正原始损失不会被隐藏。

这保证已测试的零修改链路不因 Blender 的法线表示而改变 Qt 结果，并不承诺任意编辑、模型或渲染后端均无损。
位置、UV、morph 容差分别为 `1e-5`、`1e-6`、`1e-5`；法线单位向量分量容差 `5e-4`。
不会把 Blender 的完整材质、灯光、物理和骨架行为转换到 Qt。

## 回归

```sh
nix develop .#character --command env VOIDMAKER_BLENDER_SMOKE=1 VOIDMAKER_PMX_SMOKE=1 pnpm test
pnpm check
pnpm build
```

自制 PMX 夹具覆盖真实 Blender 导入/保存/重开、正常往返、主动改顶点和法线、零修改门禁、
允许编辑、真实 Balsam 转换与目录不覆盖；纯测试覆盖顶点重排/拆分、绕序/材质/表情损坏、
稀疏访问器、缓冲区越界与空截图。测试不依赖下载角色资产。
Qt 多视角实测与这些自动化测试分别记录在 [七海接入记录](CHIAKI_CHARACTER_RESEARCH.md)。
