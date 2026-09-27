import QtQuick
import QtQuick3D

View3D {
    id: scene
    property var avatar: ({height: 20, centerY: 10, parts: []})
    property real mouth: 0
    property bool online: true
    property real blink: 0
    property real breath: 0
    readonly property var framing: avatar.framing || ({yaw: 0, zoom: 1, targetY: 0})
    readonly property real modelScale: 20 / avatar.height
    readonly property real yawRadians: framing.yaw * Math.PI / 180
    readonly property real fitWidth: avatar.width
        ? (avatar.width * Math.abs(Math.cos(yawRadians)) + (avatar.depth || 0) * Math.abs(Math.sin(yawRadians))) * modelScale + 1.2
        : 20
    environment: SceneEnvironment {
        backgroundMode: SceneEnvironment.Transparent
        antialiasingMode: SceneEnvironment.MSAA
        antialiasingQuality: SceneEnvironment.High
        tonemapMode: SceneEnvironment.TonemapModeLinear
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
        eulerRotation.y: scene.framing.yaw
        Node {
            scale: Qt.vector3d(scene.modelScale, scene.modelScale, scene.modelScale)
            x: -(scene.avatar.centerX || 0) * scene.modelScale
            y: -scene.avatar.centerY * scene.modelScale + scene.breath
            Repeater3D {
                model: scene.avatar.parts
                delegate: Node {
                    id: part
                    required property var modelData
                    Model {
                        source: modelData.meshUrl
                        materials: CharacterMaterial { part: part.modelData }
                        morphTargets: [
                            MorphTarget { weight: scene.online ? scene.mouth : 0; attributes: MorphTarget.Position },
                            MorphTarget { weight: scene.online ? scene.blink : 0; attributes: MorphTarget.Position }
                        ]
                    }
                    Model {
                        visible: !!modelData.toon && modelData.toon.edgeSize > 0 && modelData.color[3] >= 1 && modelData.toon.edgeColor[3] > 0
                        source: modelData.meshUrl
                        materials: CustomMaterial {
                            property real uEdgeWidth: part.modelData.toon ? part.modelData.toon.edgeSize * 0.025 / scene.modelScale : 0
                            property vector4d uEdgeColor: part.modelData.toon ? Qt.vector4d(...part.modelData.toon.edgeColor) : Qt.vector4d(0, 0, 0, 1)
                            cullMode: Material.FrontFaceCulling
                            vertexShader: "shaders/character-outline.vert"
                            fragmentShader: "shaders/character-outline.frag"
                        }
                        morphTargets: [
                            MorphTarget { weight: scene.online ? scene.mouth : 0; attributes: MorphTarget.Position },
                            MorphTarget { weight: scene.online ? scene.blink : 0; attributes: MorphTarget.Position }
                        ]
                    }
                }
            }
        }
    }
    SequentialAnimation on blink {
        running: scene.visible && scene.online
        loops: Animation.Infinite
        PauseAnimation { duration: 4100 }
        NumberAnimation { to: 1; duration: 90 }
        NumberAnimation { to: 0; duration: 140 }
        onStopped: scene.blink = 0
    }
    SequentialAnimation on breath {
        running: scene.visible && scene.online
        loops: Animation.Infinite
        NumberAnimation { to: 0.06; duration: 1800; easing.type: Easing.InOutSine }
        NumberAnimation { to: 0; duration: 1800; easing.type: Easing.InOutSine }
        onStopped: scene.breath = 0
    }
}
