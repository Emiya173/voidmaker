//@ pragma AppId voidmaker-character-inspector
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
    property real sleepy: 0
    property real smile: 0
    property real motionSeconds: 0
    property bool animate: false
    property bool online: true
    property bool hideCandidate: false
    property string selectedPose: "neutral"
    property real poseWeight: 1
    property string displayedPose: "neutral"
    property real poseOpacity: 1
    readonly property string referenceSource: preview
        ? (preview.poseReferences && preview.poseReferences[displayedPose]) || preview.reference : ""
    onSelectedPoseChanged: {
        if (!preview || preview.capture) {
            poseChange.stop(); displayedPose = selectedPose; poseOpacity = 1
        } else poseChange.restart()
    }
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
        applyFrame(0)
    }
    function applyFrame(index) {
        const f = preview.frames[index]
        frameIndex = index; frameName = f.name
        yaw = f.yaw; pitch = f.pitch; zoom = f.zoom; targetY = f.targetY
        mode = f.mode; mouth = f.mouth; blink = f.blink
        sleepy = f.sleepy || 0; smile = f.smile || 0
        motionSeconds = f.motionSeconds || 0; online = f.online !== false
        selectedPose = f.pose || "neutral"; poseWeight = f.poseWeight === undefined ? 1 : f.poseWeight
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
        onTriggered: {
            console.log("CHARACTER_INSPECTION_STATE", JSON.stringify({frame:root.frameName, pose:root.displayedPose,
                before:beforeScene.motionSnapshot(), after:afterScene.motionSnapshot()}))
            root.save(beforeScene, "-before", () => root.save(afterScene, "-after", () => root.save(stage, "", () => {
                if (root.frameIndex + 1 < root.preview.frames.length) root.applyFrame(root.frameIndex + 1)
                else Qt.quit()
            })))
        }
    }
    Timer {
        interval: 30; repeat: true; running: root.rotating
        onTriggered: root.yaw = (root.yaw + 181) % 360 - 180
    }
    SequentialAnimation {
        id: poseChange
        NumberAnimation { target: root; property: "poseOpacity"; to: 0; duration: 90; easing.type: Easing.InOutSine }
        ScriptAction { script: root.displayedPose = root.selectedPose }
        NumberAnimation { target: root; property: "poseOpacity"; to: 1; duration: 130; easing.type: Easing.InOutSine }
    }
    Window {
        id: window
        title: "VoidMaker Character Inspector"
        visible: true
        width: root.preview && root.preview.portrait ? 1000 : 1200
        height: root.preview && root.preview.portrait ? 1450 : 850
        color: "#171b24"
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 12
            spacing: 8
            RowLayout {
                visible: !root.preview || !root.preview.capture
                Layout.fillWidth: true
                Label { text: "Qt 角色检查台"; color: "#edf1fa"; font.bold: true }
                ComboBox {
                    model: ["正式材质", "原贴图", "纯色", "线框", "法线"]
                    currentIndex: root.mode
                    onActivated: root.mode = currentIndex
                }
                ComboBox {
                    model: root.preview ? root.preview.frames.map(f => f.name) : []
                    currentIndex: root.frameIndex
                    onActivated: root.applyFrame(currentIndex)
                }
                Item { Layout.fillWidth: true }
                Label { text: stage.portraitLayout ? "上：基准    下：候选" : "左：基准    右：候选"; color: "#b8c6db" }
            }
            RowLayout {
                visible: !root.preview || !root.preview.capture
                Layout.fillWidth: true
                CheckBox { text: "描边"; checked: root.outlines; onToggled: root.outlines = checked }
                CheckBox { text: "转台"; checked: root.rotating; onToggled: root.rotating = checked }
                CheckBox { text: "待机"; checked: root.animate; onToggled: root.animate = checked }
                CheckBox { text: "在线"; checked: root.online; onToggled: root.online = checked }
                CheckBox { text: "隐藏候选"; checked: root.hideCandidate; onToggled: root.hideCandidate = checked }
                Item { Layout.fillWidth: true }
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
                Label { text: "困倦"; color: "#b8c6db" }
                Slider { from: 0; to: 1; value: root.sleepy; onMoved: root.sleepy = value; Layout.fillWidth: true }
                Label { text: "微笑"; color: "#b8c6db" }
                Slider { from: 0; to: 1; value: root.smile; onMoved: root.smile = value; Layout.fillWidth: true }
                Label { text: "动作相位"; color: "#b8c6db" }
                Slider { from: 0; to: 12; value: root.motionSeconds; onMoved: root.motionSeconds = value; Layout.fillWidth: true }
                Label { text: "参考动作"; color: "#b8c6db" }
                ComboBox {
                    model: ["neutral"].concat(root.preview && root.preview.after.poses ? root.preview.after.poses : [])
                    currentIndex: Math.max(0, model.indexOf(root.selectedPose))
                    onActivated: { root.poseWeight = 1; root.selectedPose = model[currentIndex] }
                }
                Label { text: "诊断权重"; color: "#b8c6db" }
                Slider { from: 0; to: 1; value: root.poseWeight; onMoved: root.poseWeight = value; Layout.fillWidth: true }
            }
            Item {
                Layout.fillWidth: true; Layout.fillHeight: true
                Item {
                    id: stage
                    width: root.preview && root.preview.capture ? (root.preview.portrait ? 960 : 1120) : parent.width
                    height: root.preview && root.preview.capture ? (root.preview.portrait ? 1320 : 740) : parent.height
                    readonly property bool portraitLayout: height > width
                    anchors.centerIn: parent
                    Rectangle { anchors.fill: parent; color: "#212633" }
                    Item {
                        anchors.fill: parent
                        Item {
                            id: beforePanel
                            width: stage.portraitLayout ? (root.referenceSource ? stage.width * 0.7 : stage.width)
                                : root.referenceSource ? stage.width * 0.375 : stage.width / 2
                            height: stage.portraitLayout ? stage.height / 2 : stage.height
                            Text { y: 12; anchors.horizontalCenter: parent.horizontalCenter; text: (root.preview ? root.preview.beforeLabel : "基准") + " · " + root.frameName; color: "#edf1fa" }
                            App.Character3D {
                                id: beforeScene
                                width: root.frameName === "desktop" ? 280 : parent.width
                                height: root.frameName === "desktop" ? 490 : parent.height - 45
                                anchors.horizontalCenter: parent.horizontalCenter
                                y: 45
                                avatar: root.avatar("before")
                                automaticMotion: false
                                windowVisible: window.visible
                                online: root.online
                                viewYaw: root.yaw; viewPitch: root.pitch
                                diagnosticMode: root.mode; outlinesEnabled: root.outlines
                                mouth: root.mouth; blink: root.blink
                            }
                        }
                        Item {
                            x: stage.portraitLayout ? 0 : beforePanel.width
                            y: stage.portraitLayout ? beforePanel.height : 0
                            width: beforePanel.width; height: beforePanel.height
                            Text { y: 12; anchors.horizontalCenter: parent.horizontalCenter; text: (root.preview ? root.preview.afterLabel : "候选") + " · " + root.frameName; color: "#edf1fa" }
                            App.Character3D {
                                id: afterScene
                                width: beforeScene.width; height: beforeScene.height
                                anchors.horizontalCenter: parent.horizontalCenter
                                y: 45
                                avatar: root.avatar("after")
                                automaticMotion: root.animate
                                windowVisible: window.visible
                                online: root.online
                                visible: !root.hideCandidate
                                opacity: root.poseOpacity
                                motionSeconds: root.motionSeconds
                                sleepy: root.sleepy; smile: root.smile
                                yawn: root.displayedPose === "yawn" ? root.poseWeight : 0
                                think: root.displayedPose === "think" ? root.poseWeight : 0
                                greet: root.displayedPose === "greet" ? root.poseWeight : 0
                                viewYaw: root.yaw; viewPitch: root.pitch
                                diagnosticMode: root.mode; outlinesEnabled: root.outlines
                                mouth: root.mouth; blink: root.blink
                            }
                        }
                        Item {
                            x: beforePanel.width * (stage.portraitLayout ? 1 : 2)
                            width: stage.width - x; height: stage.height
                            visible: !!root.referenceSource
                            Text { y: 12; anchors.horizontalCenter: parent.horizontalCenter; text: "REFERENCE"; color: "#edf1fa" }
                            Image {
                                anchors { fill: parent; topMargin: 45; margins: 10 }
                                source: root.referenceSource
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
