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

# 单项修改用局部特写和明确标签；仍保留正常桌面尺寸检查
pnpm character:inspect /path/to/restored/avatar.json /path/to/shirt-study/avatar.json \
  --portrait --frames torso,front,head,desktop \
  --before-label 恢复版 --after-label 仅衬衣纹理
```

检查台直接加载正式 `Character3D.qml` 与着色器，双方共用基准模型的取景尺寸。
可同步调整旋转、俯仰、倍率、上下取景、口型与眨眼，切换正式材质、原贴图、纯色、线框、法线、描边和转台。
自动截图包含正面、左右 65°、头顶、四种诊断视图、张嘴、闭眼及 280×490 逻辑像素桌面尺寸。
另提供 `head` 头部特写和 `torso` 躯干特写；`--frames` 可选择并排序机位，未知或重复名称会报错。
报告保存有效像素数量与逐通道差异；空画面会报错。实际输出像素尺寸受当前屏幕缩放影响，比较双方一致。
像素误差只能诊断转换差异；风格、穿插、发束层次和发饰贴合仍需看图验收。
用户已否定的候选应明确标为弃用；没有翻转三角形、表情保留和测试通过，均不能证明造型改善。
先固定其余部件，只替换一项网格或单个材质贴图，避免多项微调混在一起却无法解释视觉收益。

需要实际图形会话，当前使用 Wayland/OpenGL。检查台是普通窗口，由 niri 管理位置，
不访问 Host、数据库、模型服务或麦克风。每次转换使用新目录并重新打开检查台，避免资源缓存混入旧产物。

### 竖屏预览与焦点

`--portrait` 使用上下对照布局，立绘在右侧；同时为检查台设置独立 app-id
`voidmaker-character-inspector`。该选项只改变布局，屏幕位置仍交给 niri：

```kdl
window-rule {
    match app-id="^voidmaker-character-inspector$"
    open-on-output "DP-2"
    open-focused false
    open-floating true
    default-column-width { fixed 1000; }
    default-window-height { fixed 1450; }
}
```

将输出名换成本机竖屏，加入自己的 niri 配置并运行 `niri validate`。
使用 `pnpm character:inspect ... --portrait` 打开；规则应在启动检查台前生效。
本机 DP-2 实测新检查窗位于竖屏，焦点保持在 DP-1 原窗口。
Blender 批处理使用 `--background`，不生成 GUI 窗口；如果改用 Blender GUI，需要另设对应窗口规则。
应用和检查台不设置普通窗口的绝对坐标或置顶标志。

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
审计的 `byMaterial` 按材质列出位置、法线、UV、描边与表情误差；局部修模时应检查无关材质均无超差。
各材质按引用的导出顶点去重，表情取该顶点所有 morph 的最大误差；全局表情计数仍按顶点/morph 对统计。
`_PMX_EDGE` 的修改会实际传入 Qt 描边网格，非法负数或超限值会拒绝导入。

Blender 的材质节点不作为 Qt 外观依据。贴图另存新文件，通过 `look.textures` 引用；
材质颜色、阴影强度与描边使用 `look.materials`。保持原 UV 布局，并分别看原贴图和正式材质输出。

### 效果对照与交互编辑

效果验收按用户最新要求使用 Qt 前后对照，默认在竖屏 DP-2 显示，不再自动打开 Blender GUI。
Blender 用于修模与导出；需要手动编辑时再按用户要求打开。重点角度复核不必每个微调都生成整套截图。
此前的工作工程为 `characters/chiaki/refinement/chiaki-editing-v1.blend`，
已装入当前头发/衬衣/发饰贴图、打包图像并补充 `hair:00` 到 `hair:42` 连通片选择组。
该工程随后已按用户要求直接替换为 ARP 绑定版本，默认全身取景。用户现已将 editing 工程用于其他用途，
后续造型迭代改从 `rigging/chiaki-arp-v1.blend` 建立独立工程，不再修改 editing 文件或启动入口。
启动脚本和操作说明同目录保存；这些角色资产与本地配方不入 Git。

Blender 的原始静止姿态与 Qt 的烘焙自然站姿不同，GUI 材质节点的改动也不会自动传给 Qt。
编辑外部贴图时需要保存图像并同步 `look.textures` 或具体材质引用。
普通 Blender 窗口同样由 niri 放置，例如匹配 `app-id="^blender$"` 后设置 `open-on-output "DP-2"`
与 `open-focused false`。规则只决定新窗口打开位置；用户手动移动后应保留其选择。

## Auto-Rig Pro 控制绑定

本机已从用户提供的安装包安装 Auto-Rig Pro 3.77.38，并在固定 Blender 5.1.1 中验证加载。
插件安装在用户 Blender 配置目录，不随仓库或 Nix 环境分发；本次安装包不含 Quick Rig 扩展。

本地绑定验证产物为 `characters/chiaki/rigging/chiaki-arp-v1.blend`，已按用户要求直接替换到
默认 editing 工程 `characters/chiaki/refinement/chiaki-editing-v1.blend`，本次未另存旧 editing 副本。
原 editing 启动脚本与 `rigging/open-arp.sh` 均打开默认 editing 工程并加载「七海」侧栏：
快速选择身体控制器、切换 IK/FK、显示头发/裙摆/衣饰骨骼组，以及调节表情。
初始手臂使用 FK、双脚使用 IK。新窗口继续遵循 niri 的竖屏规则。
具体操控和审计说明保存在 `rigging/README.md`。

ARP 的 Human 模板按原模型关节位置拟合并执行 Match to Rig；生成的控制骨架通过静止矩阵补偿
驱动原 MMD 蒙皮骨架。该连接由本地角色配方建立，不是 Quick Rig 转换。
原网格、UV、材质槽、权重和完整形态键数据保持不变；已接管骨骼上的旧 MMD 约束静音，避免重复驱动。
所有 177 个带权重骨骼都有对应控制；32 个表情以及 Basis、3 个 SDEF 辅助形态键保留。

保存后重开验证了静止姿态、手臂/腿 FK 与 IK、IK/FK 姿势匹配、转头、表情、手腕/手指、头发、
裙摆和视线控制；测试后恢复姿态的顶点差为零。检查结果和少量变形检查图保存在绑定目录。
这些测试不表示大幅动作已经通过美术验收：裙摆与头发仍需手动摆动，未新增物理或防穿插。

静态交换器现可处理控制骨架、蒙皮骨架和控制器网格共存的工程：按原始顶点/法线快照定位唯一角色网格，
在临时导出副本上移除骨架修改器并归零表情。控制器、当前摆姿和动画不会烘焙进导出结果，源 `.blend` 不会被保存。
缺少快照、重复角色网格或未应用几何修改器仍拒绝导出；被排除的网格记录在工具链报告中。
动画导出需要另行烘焙到原蒙皮骨架并验证目标端，不能把控制骨架直接当作已绑定 ARP 蒙皮骨架导出。
本轮未改运行时资源，也未接入 Qt 骨骼动画。重新生成 ARP 或修改参考骨骼后，需要重新验证连接矩阵。

## 从 ARP 基准继续造型

刘海恢复后的独立几何基准为 `characters/chiaki/arp-refinement-v1/chiaki-style-v4.blend`，
启动入口为同目录 `open-style.sh`。来源固定为 `rigging/chiaki-arp-v1.blend`，未使用 editing 工程。
「七海」侧栏保留 ARP 操控与表情，并增加刘海、发根、发尾、虹膜和眉毛的编辑选择按钮。
按钮定位 Basis 顶点组；手动修改后仍需复核其他形态键，不能只检查静止外观。

用户指出 v3 刘海效果变差，v4 已将完整前刘海连通片的位置、全部形态键和法线恢复到 ARP 基准，
保留该区域之外的发根、发尾、虹膜与眉弧调整。刘海分束的加宽、错落长短方案不再作为后续基准。
权重、UV、拓扑、材质分配及 36 个形态键保留；全表情位移误差小于 `1e-6`，ARP 动作与复位检查通过。
局部法线随变形修正，其他材质的原始法线编码恢复；未改变发饰或衬衣素材。
Qt 对照使用同一套已认可的材质与纹理，当前产物为 `qt-base/`、`qt-fringe-restored-v4/`，不替换正式角色。
运行同目录 `open-qt-compare.sh` 打开持续显示的 Qt 对照：上方调整前、下方调整后、右侧立绘，
可同步切换头部、俯视、侧面和表情；此入口不启动 Blender。
头顶原有的层状接缝与高光连续性仍待结构性修模，当前候选不代表风格验收完成。

后续头发表面试样保存在 `characters/chiaki/hair-surface-study-v1/`：
`chiaki-surface-v1.blend` 从上述几何基准派生，只将头发材质的图像节点换成已打包的新贴图；
保存重开核对几何、UV、权重、法线及 36 个形态键不变。Qt 候选为 `qt-candidate/`，
仅修改材质 4 的贴图路径，其他材质和 22 个网格保持不变。
当前效果对照使用该目录 `open-qt-compare.sh`；这是尚未验收的纹理候选，不自动打开 Blender 或替换正式角色。

## 法线保真策略与已知边界

真实七海模型的直接 glTF 导出出现法线量化误差，折叠眼线三角形还有明显的法线变化。
仅启用“导出法线”不足以保真，因此采用显式的浮点法线通道 `_VM_NORMAL`：

- 导入时保存位置与逐角法线快照。
- 顶点及相邻面未移动、逐角法线也未修改的区域，传递原 PMX 的法线，包括隐藏表情中的零法线。
- 编辑过的邻域或法线使用 Blender 当前逐角法线，避免覆盖有意的修模结果。
- 审计同时报告原始 `NORMAL` 导出误差与最终传递误差；修正原始损失不会被隐藏。

这保证已测试的零修改链路不因 Blender 的法线表示而改变 Qt 结果，并不承诺任意编辑、模型或渲染后端均无损。
离线批处理若调用 `normals_split_custom_set`，也会重新编码未编辑角点，尤其容易影响隐藏眼线。
本机修模脚本仅保留编辑邻域的新法线，恢复其余角点原来的 `custom_normal` 编码，并用材质审计复查；
不改写导入快照来掩盖误差。此编码操作限定于当前固定 Blender 版本的本地修模脚本。
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

## 整合修模、风格管线与立绘姿态（2026-09-27 至 28）

用户要求头发、服装、脸部表情、配件和待机五项整合后统一验收，并追加 shader/烘焙风格评估及具体立绘姿态。
工作来源为已认可的 `iris-surface-study-v1/chiaki-iris-v1.blend`，新工程位于本地 `full-refinement-v1/`。
editing 工程、原 ARP 和正式安装角色保持独立，资源不入 Git，不为效果对比打开 Blender GUI。

局部头顶重建改变了拓扑，使用该目录内的新 PMX 导出配方，不绕过原零修改交换审计。
导出按顶点、角点 UV 和自定义法线拆分，传递原权重和形态键，并删除无引用旧点；新增顶点绑定原头骨。
原 PMX 的 222 根骨骼、146 刚体和 211 关节元数据保留，不能与 Blender 中的 ARP 辅助控制骨数量混淆。
新头顶使用独立材质，原22槽顺序保持，追加的头顶槽克隆原头发 Toon 参数并使用独立纹理。
恢复常态、隐藏退化面法线归一化、重开工程和实际序列化重载均应检查。

头顶断口检查必须区分网格、纹理和描边。新表面闭合后，旧发根的反向挤出描边仍可能穿出形成黑斑；
应对连接区逐顶点渐隐，保留外侧发尾描边。纯色补片即使没有孔洞，也可能与原发束断开，不能只凭几何检查交付。

风格配置新增可选 `rampStrength`、`shadeTint` 和 UV 椭圆 `alphaFeather`，默认行为兼容旧模型。
新头顶的渐变边缘下保留原发束作为承托，先绘制实体，再混合表层，避免半球补片产生水平硬接缝。
渐变表层禁用独立描边；它不用于掩盖没有实体支撑的孔洞。
有绘制阴影的纹理降低额外 MMD ramp 占比，再按肤色、头发与深青灰外套选择轻微阴影色；避免重复压暗。
此次外套贴图由 builtin imagegen 生成，完整提示词与版本保存在本地，不能称为 AO 烘焙。
原生 Cycles 短距离 AO 已在局部副本试验：原 UV 大量重叠，独立角点颜色的小强度收益有限，增强后突出机械发片接缝，未合入。

待机使用真实六关节 Skin；立绘姿态由 ARP 离线烘焙位置与法线，正文和描边使用一致的变形数据。
混用姿态与表情时，全部目标均提供位置与法线；表情的法线差分为零，防止缺失法线在满权重时导致全身变暗。
大角度抬臂不能依赖线性形态插值；检查台以淡出、换完整姿态、淡入切换，半权重只供诊断。
接口、验证命令和能力限制见 [Qt 待机与作者姿势](CHARACTER_MOTION.md)。

统一验收版本为 `full-refinement-v1/chiaki-complete-v7.blend`、`qt-candidate-v7/avatar.json`，
入口为该目录 `open-qt-compare.sh`，实际 17 组对照在 `qt-captures-v7/`。
原 `qt-final/` 命名属于已弃用的 v3 中间产物，不作为当前入口。
v7 减少了头顶外缘透明光晕，但放大仍有薄软边；原发束高光与新发流的风格连续性保留为审美验收项。
完整姿势的抬臂衣袖仍有局部拉伸；不能把三个静态目标视为完整动作系统。
