import QtQuick
import QtQuick3D

View3D {
    id: scene
    property var avatar: ({height: 20, centerY: 10, parts: []})
    property real mouth: 0
    property bool online: true
    property real blink: 0
    property real breath: 0
    // Developer inspection overrides; production defaults preserve normal behavior.
    property bool automaticMotion: true
    property bool outlinesEnabled: true
    property int diagnosticMode: 0
    property real viewYaw: framing.yaw
    property real viewPitch: 0
    readonly property var framing: avatar.framing || ({yaw: 0, zoom: 1, targetY: 0})
    readonly property real modelScale: 20 / avatar.height
    readonly property real yawRadians: viewYaw * Math.PI / 180
    readonly property real fitWidth: avatar.width
        ? (avatar.width * Math.abs(Math.cos(yawRadians)) + (avatar.depth || 0) * Math.abs(Math.sin(yawRadians))) * modelScale + 1.2
        : 20
    environment: SceneEnvironment {
        backgroundMode: SceneEnvironment.Transparent
        antialiasingMode: SceneEnvironment.MSAA
        antialiasingQuality: SceneEnvironment.High
        tonemapMode: SceneEnvironment.TonemapModeLinear
        debugSettings: DebugSettings {
            wireframeEnabled: scene.diagnosticMode === 3
            materialOverride: scene.diagnosticMode === 4 ? DebugSettings.Normals : DebugSettings.None
        }
    }
    camera: OrthographicCamera {
        z: 60
        y: scene.framing.targetY * 20
        clipNear: 0.1
        clipFar: 200
        horizontalMagnification: Math.max(1, Math.min(scene.height / 21.5, scene.width / scene.fitWidth)) * scene.framing.zoom
        verticalMagnification: horizontalMagnification
    }
    Node {
        // Normalize every model to 20 scene units, centered vertically.
        eulerRotation.y: scene.viewYaw
        eulerRotation.x: scene.viewPitch
        pivot: Qt.vector3d(0, scene.framing.targetY * 20, 0)
        y: scene.framing.targetY * 20
        Node {
            scale: Qt.vector3d(scene.modelScale, scene.modelScale, scene.modelScale)
            x: -(scene.avatar.centerX || 0) * scene.modelScale
            y: -scene.avatar.centerY * scene.modelScale + scene.breath
            Repeater3D {
                model: scene.avatar.parts
                delegate: Node {
                    id: part
                    required property var modelData
                    readonly property var faceTargets: scene.avatar.restEyes === undefined
                        ? [mouthTarget, blinkTarget] : [mouthTarget, blinkTarget, restEyesTarget]
                    MorphTarget { id: mouthTarget; weight: scene.online ? scene.mouth : 0; attributes: MorphTarget.Position }
                    MorphTarget { id: blinkTarget; weight: scene.online ? scene.blink : 0; attributes: MorphTarget.Position }
                    // Neutral eyelids are an authored appearance, retained offline.
                    // Fade them out during the blink so the two shapes never over-close.
                    MorphTarget {
                        id: restEyesTarget
                        weight: (scene.avatar.restEyes || 0) * (1 - blinkTarget.weight)
                        attributes: MorphTarget.Position
                    }
                    Model {
                        source: modelData.meshUrl
                        materials: CharacterMaterial { part: part.modelData; diagnosticMode: scene.diagnosticMode }
                        morphTargets: part.faceTargets
                    }
                    Model {
                        visible: scene.outlinesEnabled && scene.diagnosticMode === 0 && !!modelData.toon && modelData.toon.edgeSize > 0 && modelData.color[3] >= 1 && modelData.toon.edgeColor[3] > 0
                        source: modelData.meshUrl
                        materials: CustomMaterial {
                            property real uEdgeWidth: part.modelData.toon ? part.modelData.toon.edgeSize * 0.025 / scene.modelScale * (part.modelData.style ? part.modelData.style.outlineScale : 1) : 0
                            property vector4d uEdgeColor: {
                                const color = part.modelData.style && part.modelData.style.outlineColor
                                    ? part.modelData.style.outlineColor : part.modelData.toon ? part.modelData.toon.edgeColor : [0, 0, 0]
                                return Qt.vector4d(color[0], color[1], color[2], 1)
                            }
                            cullMode: Material.FrontFaceCulling
                            vertexShader: "shaders/character-outline.vert"
                            fragmentShader: "shaders/character-outline.frag"
                        }
                        morphTargets: part.faceTargets
                    }
                }
            }
        }
    }
    SequentialAnimation on blink {
        running: scene.visible && scene.online && scene.automaticMotion
        loops: Animation.Infinite
        PauseAnimation { duration: 4100 }
        NumberAnimation { to: 1; duration: 90 }
        NumberAnimation { to: 0; duration: 140 }
        onStopped: if (scene.automaticMotion) scene.blink = 0
    }
    SequentialAnimation on breath {
        running: scene.visible && scene.online && scene.automaticMotion
        loops: Animation.Infinite
        NumberAnimation { to: 0.06; duration: 1800; easing.type: Easing.InOutSine }
        NumberAnimation { to: 0; duration: 1800; easing.type: Easing.InOutSine }
        onStopped: if (scene.automaticMotion) scene.breath = 0
    }
}
