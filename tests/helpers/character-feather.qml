import QtQuick
import QtQuick.Window
import QtQuick3D
import Quickshell
import "APP_SHELL" as App

ShellRoot {
    id: root
    property int phase: 0
    readonly property var style: ({
        tint: [1, 1, 1], saturation: 1, contrast: 1, shadeStrength: 0,
        textureStrength: 0, specularStrength: 1,
        alphaFeather: {center: [0.5, 0.5], scale: [1, 1], inner: 0.2, outer: 0.45}
    })
    Window {
        visible: true
        width: 256; height: 256
        View3D {
            id: scene
            anchors.fill: parent
            environment: SceneEnvironment {
                backgroundMode: SceneEnvironment.Transparent
                tonemapMode: SceneEnvironment.TonemapModeLinear
            }
            camera: OrthographicCamera {
                z: 300
                horizontalMagnification: 2
                verticalMagnification: 2
            }
            // Draw order intentionally opposes depth order. The opaque support
            // must write depth first, then the feathered cap blends above it.
            Model {
                visible: root.phase > 0
                source: "#Rectangle"
                z: 1
                materials: App.CharacterMaterial {
                    fragmentShader: "APP_SHADER"
                    part: root.phase === 2
                        ? {color: [0.9, 0.5, 0.55, 1], textureUrl: "", style: root.style}
                        : {color: [0.9, 0.5, 0.55, 1], textureUrl: ""}
                }
            }
            Model {
                source: "#Rectangle"
                scale: Qt.vector3d(3, 3, 1)
                materials: App.CharacterMaterial {
                    fragmentShader: "APP_SHADER"
                    part: ({color: [0.1, 0.25, 0.75, 1], textureUrl: ""})
                }
            }
        }
    }
    Timer {
        id: settle
        interval: 500
        running: true
        onTriggered: scene.grabToImage(result => {
            const path = Quickshell.env("VOIDMAKER_FEATHER_OUTPUT") + "/" + root.phase + ".png"
            if (!result.saveToFile(path)) {
                console.error("FEATHER_PROBE_FAILED", path)
                Qt.quit()
            } else if (root.phase < 3) {
                root.phase++
                settle.restart()
            } else {
                console.log("FEATHER_PROBE_OK")
                Qt.quit()
            }
        })
    }
}
