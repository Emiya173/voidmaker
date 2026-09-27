import QtQuick
import QtQuick.Window
import QtQuick.Controls.Basic
import QtQuick.Layouts
import Quickshell
import "../../shell" as App

ShellRoot {
    id: root
    property var preview: null
    property real yaw: 0
    property real pitch: 0
    property real zoom: 3
    property real targetY: 0.34
    property real mouth: 0
    property real blink: 0
    property int mode: 0
    property bool outlines: true
    property bool rotating: false
    property int frameIndex: 0
    property string frameName: "front"

    Component.onCompleted: {
        const request = new XMLHttpRequest()
        request.open("GET", Quickshell.env("VOIDMAKER_CHARACTER_PREVIEW"), false)
        request.send()
        preview = JSON.parse(request.responseText)
        if (preview.capture) applyFrame(0)
    }
    function applyFrame(index) {
        const f = preview.frames[index]
        frameIndex = index; frameName = f.name
        yaw = f.yaw; pitch = f.pitch; zoom = f.zoom; targetY = f.targetY
        mode = f.mode; mouth = f.mouth; blink = f.blink
        if (preview.capture) settle.restart()
    }
    function avatar(side) {
        if (!preview) return {height: 20, centerY: 10, parts: []}
        const result = Object.assign({}, preview[side])
        // Both candidates use the baseline bounds, so editing cannot silently reframe.
        for (const key of ["height", "width", "depth", "centerX", "centerY"])
            result[key] = preview.before[key]
        result.framing = {yaw: yaw, zoom: zoom, targetY: targetY}
        return result
    }
    function save(item, suffix, done) {
        item.grabToImage(result => {
            if (!result.saveToFile(preview.capture + "/" + frameName + suffix + ".png")) {
                console.error("Cannot save capture", frameName, suffix)
                Qt.quit()
                return
            }
            done()
        })
    }
    Timer {
        id: settle
        interval: 1200
        onTriggered: root.save(beforeScene, "-before", () => root.save(afterScene, "-after", () => root.save(stage, "", () => {
            if (root.frameIndex + 1 < root.preview.frames.length) root.applyFrame(root.frameIndex + 1)
            else Qt.quit()
        })))
    }
    Timer {
        interval: 30; repeat: true; running: root.rotating
        onTriggered: root.yaw = (root.yaw + 181) % 360 - 180
    }
    Window {
        id: window
        title: "VoidMaker Character Inspector"
        visible: true
        width: 1200; height: 850
        color: "#171b24"
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 12
            spacing: 8
            RowLayout {
                visible: !root.preview || !root.preview.capture
                Label { text: "Qt 角色检查台"; color: "#edf1fa"; font.bold: true }
                ComboBox {
                    model: ["正式材质", "原贴图", "纯色", "线框", "法线"]
                    currentIndex: root.mode
                    onActivated: root.mode = currentIndex
                }
                ComboBox {
                    model: root.preview ? root.preview.frames.map(f => f.name) : []
                    onActivated: root.applyFrame(currentIndex)
                }
                CheckBox { text: "描边"; checked: root.outlines; onToggled: root.outlines = checked }
                CheckBox { text: "转台"; checked: root.rotating; onToggled: root.rotating = checked }
                Item { Layout.fillWidth: true }
                Label { text: "左：基准    右：候选"; color: "#b8c6db" }
            }
            GridLayout {
                visible: !root.preview || !root.preview.capture
                columns: 6
                Layout.fillWidth: true
                Label { text: "旋转 " + Math.round(root.yaw) + "°"; color: "#b8c6db" }
                Slider { from: -180; to: 180; value: root.yaw; onMoved: root.yaw = value; Layout.fillWidth: true }
                Label { text: "俯仰 " + Math.round(root.pitch) + "°"; color: "#b8c6db" }
                Slider { from: -70; to: 70; value: root.pitch; onMoved: root.pitch = value; Layout.fillWidth: true }
                Label { text: "缩放 " + root.zoom.toFixed(1); color: "#b8c6db" }
                Slider { from: 0.5; to: 5; value: root.zoom; onMoved: root.zoom = value; Layout.fillWidth: true }
                Label { text: "上下"; color: "#b8c6db" }
                Slider { from: -0.5; to: 0.5; value: root.targetY; onMoved: root.targetY = value; Layout.fillWidth: true }
                Label { text: "口型"; color: "#b8c6db" }
                Slider { from: 0; to: 1; value: root.mouth; onMoved: root.mouth = value; Layout.fillWidth: true }
                Label { text: "眨眼"; color: "#b8c6db" }
                Slider { from: 0; to: 1; value: root.blink; onMoved: root.blink = value; Layout.fillWidth: true }
            }
            Item {
                Layout.fillWidth: true; Layout.fillHeight: true
                Item {
                    id: stage
                    width: root.preview && root.preview.capture ? 1120 : parent.width
                    height: root.preview && root.preview.capture ? 740 : parent.height
                    anchors.centerIn: parent
                    Rectangle { anchors.fill: parent; color: "#212633" }
                    Row {
                        anchors.fill: parent
                        Item {
                            width: root.preview && root.preview.reference ? stage.width * 0.375 : stage.width / 2
                            height: stage.height
                            Text { y: 12; anchors.horizontalCenter: parent.horizontalCenter; text: "BEFORE · " + root.frameName; color: "#edf1fa" }
                            App.Character3D {
                                id: beforeScene
                                width: root.frameName === "desktop" ? 280 : parent.width
                                height: root.frameName === "desktop" ? 490 : parent.height - 45
                                anchors.centerIn: parent
                                avatar: root.avatar("before")
                                automaticMotion: false
                                viewYaw: root.yaw; viewPitch: root.pitch
                                diagnosticMode: root.mode; outlinesEnabled: root.outlines
                                mouth: root.mouth; blink: root.blink
                            }
                        }
                        Item {
                            width: root.preview && root.preview.reference ? stage.width * 0.375 : stage.width / 2
                            height: stage.height
                            Text { y: 12; anchors.horizontalCenter: parent.horizontalCenter; text: "AFTER · " + root.frameName; color: "#edf1fa" }
                            App.Character3D {
                                id: afterScene
                                width: beforeScene.width; height: beforeScene.height
                                anchors.centerIn: parent
                                avatar: root.avatar("after")
                                automaticMotion: false
                                viewYaw: root.yaw; viewPitch: root.pitch
                                diagnosticMode: root.mode; outlinesEnabled: root.outlines
                                mouth: root.mouth; blink: root.blink
                            }
                        }
                        Item {
                            width: stage.width / 4; height: stage.height
                            visible: !!root.preview && !!root.preview.reference
                            Text { y: 12; anchors.horizontalCenter: parent.horizontalCenter; text: "REFERENCE"; color: "#edf1fa" }
                            Image {
                                anchors { fill: parent; topMargin: 45; margins: 10 }
                                source: root.preview ? root.preview.reference : ""
                                fillMode: Image.PreserveAspectFit
                                verticalAlignment: Image.AlignTop
                            }
                        }
                    }
                }
            }
        }
    }
}
