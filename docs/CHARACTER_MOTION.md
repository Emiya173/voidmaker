# Qt 角色待机与作者姿势

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

## 作者姿势文件

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

大角度抬手的线性顶点中间态会压扁袖子和手指，不能作为正常动作播放。`*-half` 截图和“诊断权重”滑块仅供排查该限制；正常姿势选择始终恢复完整权重，并通过画面淡出/淡入避免显示塌陷中间态。以后若需要连续动作，应另行导出实际骨骼轨迹。

## 检查

`character:inspect` 新增 `back,sleepy,smile,talk,idle-a,idle-b,offline,yawn,think,greet,yawn-half,think-half,greet-half` 机位。前侧保持静止基准，后侧可以启用待机，测试在线/断连、隐藏/显示以及姿势选择。截图使用确定的动作相位，便于复现；这些检查无需 Host、麦克风或 Blender GUI。

`--pose-references 文件.json` 接受 `{ "yawn": "立绘路径", "think": "立绘路径", "greet": "立绘路径" }`，选择动作时同步切换参考图。路径可以是绝对路径或相对该 JSON 的路径；常态仍显示 `--reference` 指定的立绘。截图日志同时记录实际关节位置和八个形态键权重。

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
