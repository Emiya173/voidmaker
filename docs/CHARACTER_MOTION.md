# Qt 角色待机与作者姿势

当前有两种互斥的蒙皮路径：本文原有的 `idleRig` 六关节待机/静态姿势，以及新增的 `motionRig` 完整作者动作。
后者保留原始绑定与权重，播放局部关节轨迹，三个 pose 槽默认承载脸部目标，也可加入经过范围校验的局部衣料修正；具体接口和命令见
[连续骨骼动作导出与检查](CHARACTER_EDITING.md#连续骨骼动作导出与检查)。下文淡出换姿与半权重诊断仅适用于旧路径。
完整骨骼动作现支持哈欠（`yawn`）、思考（`think`）、远望（`greet`）的进入、停留和收回，无 VMD、物理、跨动作混合或完整骨架待机叠加。`greet` 为早期误读动作时留下的资源 ID，保留它以兼容现有文件；用户可见标签为“远望”。

角色转换可以保留一个精简的运行时蒙皮：固定根、胸口、颈部、头部和两只眼睛。转换器按 PMX 原骨骼的祖先关系归并权重，保留材质、轮廓和脸部形态键。脚部权重留在固定根；呼吸、轻微头动和视线改变作用于局部关节。正文与描边使用同一个 [Qt Quick 3D Skin](https://doc.qt.io/qt-6/qml-qtquick3d-skin.html)。

外观配置中的 `idleMotion: true` 启用转换，旧配置仍生成静态网格。需要唯一的 `上半身`、`首`、`頭`、`左目`、`右目` 骨骼；缺失、循环父子关系或无效权重会拒绝转换。`--pose relaxed` 仍负责烘焙放松站姿，六个关节在该站姿上重新绑定，不提供运行时 ARP、MMD IK、物理或任意骨骼动画。

```json
{
  "idleMotion": true,
  "restEyes": { "morph": "ジト目", "weight": 0.3 },
  "expressions": {
    "sleepy": { "morphs": { "ジト目": 0.8, "まばたき": 0.24, "下": 0.15, "口_下": 0.1 } },
    "smile": { "morphs": { "ジト目": 0.15, "笑い": 0.12, "にやり": 0.8, "にこり": 0.6 } }
  },
  "poses": { "yawn": "poses/yawn.json", "think": "poses/think.json", "greet": "poses/greet.json" }
}
```

`expressions` 按模型真实的顶点形态键组合成两个可选目标。未找到形态键会失败，不能用同名占位代替。`restEyes` 在困倦、微笑和闭眼时淡出，防止重复压低眼睑。

## 作者姿势文件（旧静态路径）

ARP 姿势由 Blender 离线求值。对最终网格烘焙身体、手指、脸部表情，输出每个 PMX 顶点对应的绝对位置与单位法线：

```json
{
  "sourceSha256": "最终源PMX的64个十六进制字符SHA256",
  "positions": [[0, 0, 0]],
  "normals": [[0, 1, 0]]
}
```

实际数组长度必须等于最终 PMX 的顶点数，索引顺序必须一致。坐标采用右手系 Qt/PMX parser 输出：Blender `(x,y,z)` 转为 `(x,z,-y)`。这些是已完成作者动作的绝对位置，不要再次应用转换器的放松站姿。法线必须归一化；隐藏退化面允许零法线。文件位置相对外观配置，拒绝目录越界、指纹不符和顶点数不一致。

转换器从目标减去最终放松站姿，生成 `POSITION` 与 `NORMAL` 两种 [morph 属性](https://doc.qt.io/qt-6/qml-qtquick3d-morphtarget.html)。完整组合为最多八个槽：口型、闭眼、可选常态眼睑、两个可选表情、三个可选姿势。包含姿势时，所有表情槽也输出零差分 `NORMAL`，运行时统一启用法线通道；Qt 会将缺失通道读成零法线，导致满权重表情使全身变暗并失去描边。旧的纯表情模型继续仅使用位置通道。姿势插值是顶点线性插值，跨度大的手臂动作必须检查中间状态；不能视为完整骨骼动画导出。

完整作者姿势会关闭关节待机与独立脸部形态键，使用姿势内烘焙的表情，避免旋转后的脸部叠加原坐标差分。退出姿势后恢复正常控制。检查台正常切换先在 90 ms 内淡出画面，瞬时更换完整姿势，再在 130 ms 内淡入。这里切换的是离线 ARP 烘焙静态姿态，不是连续骨骼动作。

大角度抬手的线性顶点中间态会压扁袖子和手指，不能作为正常动作播放。`*-half` 截图和“诊断权重”滑块仅供排查该限制；正常姿势选择始终恢复完整权重，并通过画面淡出/淡入避免显示塌陷中间态。连续动作使用新的 `motionRig` 导出路径。

## 可选局部衣料修正

连续骨骼动作可以保留已经确定的关节轨迹和蒙皮权重，通过局部姿态修正（pose corrective）调整衣料。例如，现有 `think` morph 可同时包含脸部变化与内袖的绑定空间（bind space）差分，由原片段的 `expression` 权重曲线一起驱动。抬臂、手腕和手指仍由骨骼轨道求值，局部目标只修正衣料形状，不包含整套身体骨姿。运行时复用已有八个形态槽，无须新增应用接口。

通用骨骼导出器仍输出仅含脸部变化的目标；本地资产构建步骤可在导出后追加衣料差分。源顶点索引需经同版 PMX 的顶点/角点映射展开，位置和法线分别烘焙为 `POSITION`、`NORMAL` 目标，并保留原脸部目标。当前内袖实验限定上着 `part_8` 的 `think` 数据，其余目标、部件网格、绑定、权重、骨骼片段和材质保持不变。具体构建与范围检查见[局部衣料姿态修正](CHARACTER_EDITING.md#局部衣料姿态修正)。

此方法仍需检查权重曲线覆盖的整个进入、停留与收回过程，尤其是形态逐渐淡入、淡出时的内外袖关系。验收应以相同秒数的旧、新骨骼动画进行正面和侧面比较，并分别记录几何复验与实际 Qt 外观；完成导出或局部采样不能证明全程无穿插。

## 检查

`character:inspect` 新增 `back,sleepy,smile,talk,idle-a,idle-b,offline,yawn,think,greet,yawn-half,think-half,greet-half` 机位。前侧保持静止基准，后侧可以启用待机，测试在线/断连、隐藏/显示以及姿势选择。截图使用确定的动作相位，便于复现；这些检查无需 Host、麦克风或 Blender GUI。

`--pose-references 文件.json` 接受 `{ "yawn": "立绘路径", "think": "立绘路径", "greet": "立绘路径" }`，选择动作时同步切换参考图。路径可以是绝对路径或相对该 JSON 的路径；常态仍显示 `--reference` 指定的立绘。截图日志同时记录实际关节位置和八个形态键权重。

比较旧静态姿势修正时加 `--sync-poses`，前后模型会使用同一个完整姿势、诊断权重和切换淡出/淡入；基准仍关闭自动待机。两侧均有 `motionRig` 时，此参数改为同步同名骨骼动作与绝对秒数，基准跟随候选时钟且在自己的时长末端钳制；截图等待两侧资源就绪。动作修改应比较旧动画与新动画，旧静态基准仅能作为完整造型参考。默认不加该参数时，基准继续保持中性站姿。`yawn-detail,think-detail,greet-detail` 放大手部与口部，适用于旧静态路径的同姿势修正。示例：

```bash
pnpm character:inspect before/avatar.json after/avatar.json --portrait --sync-poses \
  --frames yawn-detail,think-detail,greet-detail --capture new-comparison-directory
```

垂下手使用 `yawn-hand,think-hand,greet-hand`：从掌侧观察，保留袖口至全部指尖，避免正面视角把手指叠成一条线。主动手另有 `think-fingers,greet-fingers` 侧向近景，可检查食指弯曲、指尖与下巴的距离，以及拇指相对掌面的方向。全部使用完整姿势权重，取景参数如下：

| 机位 | yaw | zoom | targetY |
| --- | ---: | ---: | ---: |
| yawn-hand / think-hand | -65° | 4 | -0.03 |
| greet-hand | 65° | 4 | -0.03 |
| think-fingers | -75° | 4 | 0.32 |
| greet-fingers | 75° | 4 | 0.36 |

```bash
pnpm character:inspect before/avatar.json after/avatar.json --portrait --sync-poses \
  --frames yawn-hand,think-hand,greet-hand,think-fingers,greet-fingers \
  --capture new-hand-comparison-directory
```

自动待机在视图或所属窗口隐藏、断连时停止并恢复关节中性状态，换角色会从零重新计时。离线保留作者定义的常态眼睑外观。旧网格保留自动眨眼，不再使用整个模型上下平移模拟呼吸。

验证命令：

```bash
nix develop --command pnpm test tests/character-idle.test.ts tests/character-pose.test.ts
nix develop --command env VOIDMAKER_PMX_SMOKE=1 pnpm test tests/character-convert.test.ts
nix develop --command env VOIDMAKER_QML_SMOKE=1 pnpm test tests/character-motion.test.ts
nix develop --command env VOIDMAKER_QT_RENDER_SMOKE=1 pnpm test tests/character-render.test.ts
```

PMX smoke 使用原创小网格和真实 Balsam，检查蒙皮属性、关节顺序、八个槽及作者姿势坐标。QML smoke 使用离屏软件后端，验证真实 QML 关节、权重和生命周期，不代表 GPU 外观验收。render smoke 需要 Xvfb 和 Mesa，在独立虚拟显示中执行真实 OpenGL shader 管线，分别验证正文与仅描边的八槽动作、法线和蒙皮输出；满权重口型、眨眼与零位移表情必须和不含姿势通道的基线逐像素一致，防止缺失法线导致全身阴影和轮廓退化。测试不创建用户桌面窗口。

描边自定义 vertex shader 必须显式应用形态键后再挤出；Qt 对这类自定义 vertex shader 不自动应用 morph 位置。仅给轮廓 Model 设置 `morphTargets` 会留下未变形的外壳。运行时已在正文和描边上共用 Skin，并在描边 shader 混合位置与法线目标。

最终仍须在实际 Qt 材质下检查全身、头部、闭眼和三种完整姿势，并确认正常切换不播放诊断中间态。虚拟显示的 shader 能力检查不替代实际角色造型验收。
