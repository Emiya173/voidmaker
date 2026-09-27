import QtQuick
import QtQuick3D

View3D {
    id: scene
    property var avatar: ({height: 20, centerY: 10, parts: []})
    property real mouth: 0
    property bool online: true
    property real blink: 0
    property real breath: 0
    environment: SceneEnvironment {
        backgroundMode: SceneEnvironment.Transparent
        antialiasingMode: SceneEnvironment.MSAA
        antialiasingQuality: SceneEnvironment.High
    }
    camera: OrthographicCamera {
        z: 60
        clipNear: 0.1
        clipFar: 200
        horizontalMagnification: Math.max(1, Math.min(scene.height / 23, scene.width / 20))
        verticalMagnification: horizontalMagnification
    }
    Node {
        // Normalize every model to 20 scene units, centered vertically.
        scale: Qt.vector3d(20 / scene.avatar.height, 20 / scene.avatar.height, 20 / scene.avatar.height)
        y: -scene.avatar.centerY * 20 / scene.avatar.height + scene.breath
        Repeater3D {
            model: scene.avatar.parts
            delegate: Model {
                required property var modelData
                source: modelData.meshUrl
                materials: PrincipledMaterial {
                    lighting: PrincipledMaterial.NoLighting
                    baseColor: Qt.rgba(modelData.color[0], modelData.color[1], modelData.color[2], modelData.color[3])
                    baseColorMap: Texture { source: modelData.textureUrl }
                    cullMode: modelData.doubleSided ? Material.NoCulling : Material.BackFaceCulling
                    alphaMode: modelData.color[3] < 1 ? PrincipledMaterial.Blend : PrincipledMaterial.Mask
                    alphaCutoff: 0.1
                }
                morphTargets: [
                    MorphTarget { weight: scene.online ? scene.mouth : 0; attributes: MorphTarget.Position },
                    MorphTarget { weight: scene.online ? scene.blink : 0; attributes: MorphTarget.Position }
                ]
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
