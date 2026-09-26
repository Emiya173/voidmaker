//@ pragma AppId voidmaker
//@ pragma ShellId voidmaker

import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io

ShellRoot {
    id: root

    property bool expanded: false
    property bool hidden: false
    property bool composeOpen: false
    property bool captureActive: false
    property bool captureReturnExpanded: false
    property bool captureReturnHidden: false
    property bool captureReturnCompose: false
    property string captureDraft: ""
    property bool bubbleShown: false
    property bool bubbleEnabled: true
    property bool busy: false
    property bool permissionPending: false
    property bool recording: false
    property bool voiceChat: false
    property bool casualChat: false
    property bool autoPermissions: false
    property bool sttEnabled: false
    property bool actionHover: false
    property bool actionButtonHovered: false
    property bool toastShown: false
    property string toastText: ""
    property string characterName: "VoidMaker"
    property string portraitSource: ""
    property string bubbleText: ""
    property string permissionTool: ""
    property string permissionDetail: ""
    property string noteTitle: "记事"
    property string noteContent: ""
    property string page: "chat"
    property string statusText: "等待连接…"

    onExpandedChanged: {
        if (expanded) {
            composeOpen = false
            actionHover = false
            actionButtonHovered = false
            hideActionsDelay.stop()
        }
    }

    function toggleStage() {
        if (root.captureActive)
            return
        if (root.hidden) {
            root.hidden = false
            root.expanded = false
        } else {
            root.expanded = !root.expanded
        }
    }

    function toggleVisibility() {
        if (root.hidden)
            root.hidden = false
        else
            root.hidePet()
    }

    function hidePet() {
        if (root.captureActive) {
            root.captureReturnHidden = true
            root.captureReturnExpanded = false
            root.captureReturnCompose = false
            return
        }
        if (root.permissionPending) {
            root.statusText = "请先处理权限请求"
            return
        }
        root.composeOpen = false
        root.expanded = false
        root.actionHover = false
        root.actionButtonHovered = false
        hideActionsDelay.stop()
        root.toastShown = false
        root.hidden = true
    }

    function showToast(message) {
        root.toastText = message
        root.toastShown = true
        toastTimer.restart()
    }

    function send(data) {
        if (backend.running)
            backend.write(JSON.stringify(data) + "\n")
    }

    function sendText() {
        const text = input.text.trim()
        if (!text || root.busy)
            return
        root.send({cmd: "send", text: text})
        input.text = ""
    }

    function sendQuickText() {
        const text = quickInput.text.trim()
        if (!text || root.busy)
            return
        root.send({cmd: "send", text: text})
        quickInput.text = ""
        root.composeOpen = false
        root.showToast("消息已发送，等待回复")
    }

    function openCompose() {
        root.hidden = false
        root.expanded = false
        root.composeOpen = true
        Qt.callLater(() => quickInput.forceActiveFocus())
    }

    function startCapture() {
        if (root.captureActive || root.busy || !backend.running)
            return
        root.captureReturnExpanded = root.expanded
        root.captureReturnHidden = root.hidden
        root.captureReturnCompose = root.composeOpen
        root.captureDraft = root.hidden ? "" : root.expanded ? input.text : quickInput.text
        root.captureActive = true
        captureDelay.start()
    }

    function addMessage(role, text, imageSource = "") {
        if (!text && !imageSource)
            return
        messages.append({role: role, content: text || "", imageSource: imageSource || ""})
        conversation.positionViewAtEnd()
    }

    function receive(line) {
        let event
        try {
            event = JSON.parse(line)
        } catch (error) {
            console.warn("VoidMaker bridge:", line)
            return
        }
        switch (event.type) {
        case "hello":
            root.characterName = event.name || "VoidMaker"
            root.portraitSource = event.portrait || ""
            root.bubbleEnabled = event.bubble_enabled
            root.sttEnabled = event.stt_enabled
            root.casualChat = event.casual_chat
            root.autoPermissions = event.auto_permissions
            root.statusText = "已连接"
            if (event.greeting) {
                root.bubbleText = event.greeting
                root.bubbleShown = true
                root.addMessage("assistant", event.greeting)
            }
            break
        case "message":
            root.addMessage(event.role, event.text, event.image)
            break
        case "bubble":
            root.bubbleText = event.text
            root.bubbleShown = true
            break
        case "bubble_hide":
            root.bubbleShown = false
            break
        case "portrait":
            root.portraitSource = event.path || ""
            break
        case "busy":
            root.busy = event.value
            break
        case "permission":
            root.permissionTool = event.tool
            root.permissionDetail = event.detail
            root.permissionPending = true
            root.page = "chat"
            root.hidden = false
            root.expanded = true
            break
        case "permission_hide":
            root.permissionPending = false
            break
        case "notepad":
            root.noteTitle = event.title || "记事"
            root.noteContent = event.content || ""
            root.page = "notes"
            root.hidden = false
            root.expanded = true
            break
        case "draft":
            input.text = event.text || ""
            if (event.text) {
                root.hidden = false
                root.expanded = true
            }
            break
        case "snip_done":
            root.captureActive = false
            root.expanded = root.captureReturnExpanded
            root.hidden = root.captureReturnHidden
            root.composeOpen = root.captureReturnCompose
            if (event.ok)
                quickInput.text = ""
            if (event.ok && !root.captureReturnExpanded && !root.captureReturnHidden)
                root.showToast("截图已发送，展开侧栏可查看")
            if (!event.ok)
                root.statusText = "截图已取消"
            break
        case "recording":
            root.recording = event.value
            break
        case "voice_chat":
            root.voiceChat = event.value
            break
        case "casual_chat":
            root.casualChat = event.value
            break
        case "auto_permissions":
            root.autoPermissions = event.value
            break
        case "error":
            root.statusText = event.text
            root.addMessage("assistant", "出错了：" + event.text)
            break
        case "toggle":
            root.toggleStage()
            break
        case "visibility":
            root.toggleVisibility()
            break
        case "quit":
            Qt.quit()
            break
        }
    }

    ListModel { id: messages }

    IpcHandler {
        target: "voidmaker"
        function stage(): string { return root.hidden ? "hidden" : root.expanded ? "details" : root.composeOpen ? "compose" : "portrait" }
        function toggle(): void { root.toggleStage() }
        function visibility(): void { root.toggleVisibility() }
        function compose(): void { root.openCompose() }
        function hide(): void { root.hidePet() }
        function capture(): void { root.startCapture() }
    }

    Timer {
        id: captureDelay
        interval: 300
        repeat: false
        onTriggered: root.send({cmd: "snip", text: root.captureDraft})
    }

    Timer {
        id: hideActionsDelay
        interval: 400
        repeat: false
        onTriggered: {
            if (!portraitHit.containsMouse && !hoverBridge.containsMouse
                    && !railPointerArea.containsMouse && !root.actionButtonHovered)
                root.actionHover = false
        }
    }

    Timer {
        id: toastTimer
        interval: 2600
        repeat: false
        onTriggered: root.toastShown = false
    }

    Process {
        id: backend
        running: Quickshell.env("VOIDMAKER_SHELL_PREVIEW") !== "1"
        command: [Quickshell.env("VOIDMAKER_PYTHON") || "python", "-m", "voidmaker", "--bridge"]
        stdinEnabled: true
        stdout: SplitParser { onRead: line => root.receive(line) }
        stderr: SplitParser { onRead: line => console.log("[voidmaker] " + line) }
        onRunningChanged: {
            if (!running && Quickshell.env("VOIDMAKER_SHELL_PREVIEW") !== "1") {
                root.captureActive = false
                root.statusText = "后端已断开"
            }
        }
    }

    PanelWindow {
        id: panel
        anchors { top: true; bottom: true; right: true }
        implicitWidth: 880
        color: "transparent"
        exclusionMode: ExclusionMode.Ignore
        visible: !root.captureActive && !root.hidden
        focusable: root.expanded || root.composeOpen
        mask: root.expanded ? drawerMask : root.actionHover ? hoverMask : portraitMask

        Region {
            id: drawerMask
            item: drawer
        }

        Region {
            id: portraitMask
            item: portraitHit
            Region { item: quickComposer }
        }

        Region {
            id: hoverMask
            x: portraitDock.x - 72
            y: portraitDock.y
            width: portraitDock.width + 72
            height: portraitDock.height
            Region { item: quickComposer }
        }

        Item {
            id: canvas
            anchors.fill: parent
            focus: root.expanded || root.composeOpen
            Keys.onPressed: event => {
                if (event.key === Qt.Key_Escape && (root.expanded || root.composeOpen)) {
                    root.expanded = false
                    root.composeOpen = false
                    event.accepted = true
                }
            }

            Rectangle {
                id: drawer
                x: root.expanded ? 14 : panel.width + 20
                y: 64
                width: panel.width - 28
                height: Math.max(0, panel.height - y - 16)
                radius: 26
                color: "#f21b2031"
                gradient: Gradient {
                    GradientStop { position: 0.0; color: "#f32b2940" }
                    GradientStop { position: 0.52; color: "#f21d2235" }
                    GradientStop { position: 1.0; color: "#f0141d2e" }
                }
                border.color: "#678e91a9"
                border.width: 1
                opacity: root.expanded ? 1 : 0
                visible: opacity > 0
                Behavior on x { NumberAnimation { duration: 280; easing.type: Easing.OutCubic } }
                Behavior on opacity { NumberAnimation { duration: 200 } }

                Rectangle {
                    anchors.fill: parent
                    anchors.margins: 1
                    radius: 25
                    color: "transparent"
                    border.color: "#24ffffff"
                }

                Text {
                    x: 32; y: 29
                    text: "VOIDMAKER"
                    color: "#f7b9d7"
                    font.pixelSize: 13
                    font.bold: true
                    font.letterSpacing: 2.5
                }
                Text {
                    x: 32; y: 59
                    text: "与" + root.characterName + "对话"
                    color: "#fff7fb"
                    font.pixelSize: 25
                    font.bold: true
                }
                Text {
                    x: 34; y: 102
                    text: root.statusText
                    color: "#bbc1d3"
                    font.pixelSize: 13
                    elide: Text.ElideRight
                    width: 404
                }

                Row {
                    x: 31; y: 143
                    spacing: 8
                    Repeater {
                        model: ["chat", "notes"]
                        delegate: Rectangle {
                            required property string modelData
                            width: 92; height: 38; radius: 11
                            color: root.page === modelData ? "#724b66" : "#263041"
                            border.color: root.page === modelData ? "#d493b4" : "#576273"
                            Text {
                                anchors.centerIn: parent
                                text: parent.modelData === "chat" ? "对话" : "记事"
                                color: root.page === parent.modelData ? "#fff6fb" : "#bdc4d4"
                                font.pixelSize: 14
                                font.bold: root.page === parent.modelData
                            }
                            MouseArea {
                                anchors.fill: parent
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.page = parent.modelData
                            }
                        }
                    }
                }
                Rectangle { x: 32; y: 191; width: 418; height: 1; color: "#56858ba3" }

                ListView {
                    id: conversation
                    x: 32; y: 208
                    width: 418
                    height: drawer.height - (root.permissionPending ? 484 : 378)
                    visible: root.page === "chat"
                    clip: true
                    spacing: 14
                    model: messages
                    delegate: Item {
                        required property string role
                        required property string content
                        required property string imageSource
                        width: conversation.width
                        height: messageBox.implicitHeight + 14
                        Rectangle {
                            id: messageBox
                            x: role === "user" ? parent.width - width : 0
                            width: imageSource ? 386 : Math.min(parent.width - 22, messageText.implicitWidth + 32)
                            implicitHeight: messageText.implicitHeight + (imageSource ? 178 : 0) + 20
                            radius: 16
                            color: role === "user" ? "#34475d" : "#514358"
                            border.color: role === "user" ? "#50647a" : "#745b76"
                            Text {
                                id: messageText
                                x: 14; y: 10
                                width: Math.min(354, implicitWidth)
                                text: content
                                wrapMode: Text.Wrap
                                color: "#f8edf4"
                                font.pixelSize: 14
                                lineHeight: 1.35
                            }
                            Image {
                                x: 14
                                y: messageText.y + messageText.implicitHeight + 8
                                width: 358
                                height: 170
                                source: imageSource
                                visible: imageSource !== ""
                                fillMode: Image.PreserveAspectFit
                                asynchronous: true
                                smooth: true
                            }
                        }
                    }
                }

                Rectangle {
                    x: 32; y: 222; width: 418; height: 152; radius: 17
                    visible: root.page === "chat" && messages.count === 0
                    color: "#2b3648"; border.color: "#597086"
                    Text { x: 20; y: 18; text: "准备好开始对话"; color: "#fff0f7"; font.pixelSize: 17; font.bold: true }
                    Text { x: 20; y: 52; width: 378; text: "输入消息，或截取一块屏幕让她看看。"; color: "#c2c9d6"; font.pixelSize: 13 }
                    Rectangle {
                        x: 20; y: 96; width: 124; height: 38; radius: 10
                        color: "#77516c"; border.color: "#c48eae"
                        Text { anchors.centerIn: parent; text: "输入消息"; color: "#fff4fa"; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: input.forceActiveFocus() }
                    }
                    Rectangle {
                        x: 154; y: 96; width: 124; height: 38; radius: 10
                        color: "#34485b"; border.color: "#7393a4"
                        Text { anchors.centerIn: parent; text: "截图选区"; color: "#eafbf9"; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.startCapture() }
                    }
                }

                Flickable {
                    x: 33; y: 210
                    width: 417; height: drawer.height - 270
                    visible: root.page === "notes"
                    clip: true
                    contentWidth: width
                    contentHeight: noteBody.implicitHeight + 50
                    Text {
                        x: 0; y: 0
                        text: root.noteTitle
                        color: "#ffe0eb"
                        font.pixelSize: 21
                        font.bold: true
                    }
                    Text {
                        id: noteBody
                        x: 0; y: 37
                        width: 400
                        text: root.noteContent || "助手整理的长内容会出现在这里。"
                        wrapMode: Text.Wrap
                        color: "#d9d1df"
                        font.pixelSize: 14
                        lineHeight: 1.45
                    }
                }

                Rectangle {
                    id: permissionCard
                    x: 32; y: drawer.height - 250
                    width: 418; height: 138
                    radius: 16
                    visible: root.permissionPending && root.page === "chat"
                    color: "#564252"
                    border.color: "#d297b6"
                    Text { x: 17; y: 13; text: "权限请求 · " + root.permissionTool; color: "#ffeaf2"; font.pixelSize: 15; font.bold: true }
                    Text { x: 17; y: 42; width: 384; height: 35; text: root.permissionDetail; wrapMode: Text.Wrap; elide: Text.ElideRight; color: "#ead7e1"; font.pixelSize: 12 }
                    Row {
                        x: 12; y: 88; spacing: 8
                        Repeater {
                            model: [{label: "拒绝", choice: "deny"}, {label: "仅这次", choice: "once"}, {label: "一直允许", choice: "always"}]
                            delegate: Rectangle {
                                required property var modelData
                                width: 126; height: 38; radius: 10
                                color: modelData.choice === "once" ? "#ffd2e0" : "#405064"
                                Text { anchors.centerIn: parent; text: parent.modelData.label; color: parent.modelData.choice === "once" ? "#382a39" : "#f6eaf1"; font.pixelSize: 13 }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.send({cmd: "permission", choice: parent.modelData.choice}) }
                            }
                        }
                    }
                }

                Rectangle {
                    x: 32; y: drawer.height - 101
                    width: 418; height: 52; radius: 14
                    color: "#273246"
                    border.color: "#8491aa"
                    visible: root.page === "chat"
                    TextField {
                        id: input
                        x: 14; y: 3; width: 324; height: 46
                        placeholderText: root.busy ? "正在回复…" : "和她说点什么……"
                        placeholderTextColor: "#aeb8ca"
                        enabled: !root.busy
                        color: "#fff4f8"
                        font.pixelSize: 14
                        background: Item {}
                        onAccepted: root.sendText()
                    }
                    Rectangle {
                        x: 345; y: 5; width: 66; height: 42; radius: 10
                        color: root.busy ? "#655c6d" : "#ffd5e4"
                        Text { anchors.centerIn: parent; text: "发送"; color: "#342a3b"; font.pixelSize: 14; font.bold: true }
                        MouseArea { anchors.fill: parent; enabled: !root.busy; cursorShape: Qt.PointingHandCursor; onClicked: root.sendText() }
                    }
                }

                Row {
                    x: 32; y: drawer.height - 41; spacing: 8
                    visible: root.page === "chat"
                    Rectangle {
                        width: 134; height: 30; radius: 9
                        color: "#2b394b"; border.color: "#587184"
                        Text { anchors.centerIn: parent; text: root.recording ? "停止录音" : "语音输入"; color: root.sttEnabled ? "#d2f1e8" : "#84909f"; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; enabled: root.sttEnabled; cursorShape: Qt.PointingHandCursor; onClicked: root.send({cmd: "mic"}) }
                    }
                    Rectangle {
                        width: 134; height: 30; radius: 9
                        color: "#2b394b"; border.color: "#587184"
                        Text { anchors.centerIn: parent; text: "截图选区"; color: "#d2f1e8"; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.startCapture() }
                    }
                    Rectangle {
                        width: 134; height: 30; radius: 9
                        color: root.voiceChat ? "#46665f" : "#2b394b"; border.color: "#587184"
                        Text { anchors.centerIn: parent; text: root.voiceChat ? "连续对话中" : "连续对话"; color: root.sttEnabled ? "#d2f1e8" : "#84909f"; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; enabled: root.sttEnabled; cursorShape: Qt.PointingHandCursor; onClicked: root.send({cmd: "voice_chat", value: !root.voiceChat}) }
                    }
                }

                Text {
                    x: 480; y: 27
                    text: "Esc 收起  ·  点击立绘切换"
                    color: "#c4c5d2"; font.pixelSize: 12
                }
                Rectangle {
                    x: 480; y: 54; width: 280; height: 38; radius: 11
                    color: "#314052"; border.color: "#586a7c"
                    Text { x: 13; anchors.verticalCenter: parent.verticalCenter; text: "主动闲聊"; color: "#f0e8f0"; font.pixelSize: 13 }
                    Text { x: 222; anchors.verticalCenter: parent.verticalCenter; text: root.casualChat ? "已开启" : "已关闭"; color: root.casualChat ? "#a9ebd5" : "#c0b8c7"; font.pixelSize: 12 }
                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.send({cmd: "casual_chat", value: !root.casualChat}) }
                }
                Rectangle {
                    x: 480; y: 100; width: 280; height: 38; radius: 11
                    color: "#314052"; border.color: "#586a7c"
                    Text { x: 13; anchors.verticalCenter: parent.verticalCenter; text: "工具权限"; color: "#f0e8f0"; font.pixelSize: 13 }
                    Text { x: root.autoPermissions ? 224 : 197; anchors.verticalCenter: parent.verticalCenter; text: root.autoPermissions ? "自动" : "逐次确认"; color: root.autoPermissions ? "#a9ebd5" : "#c0b8c7"; font.pixelSize: 12 }
                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.send({cmd: "auto_permissions", value: !root.autoPermissions}) }
                }
                Rectangle {
                    x: 480; y: 146; width: 132; height: 30; radius: 9
                    color: "#304052"; border.color: "#637489"
                    Text { anchors.centerIn: parent; text: "隐藏立绘"; color: "#dfe5ef"; font.pixelSize: 12 }
                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.hidePet() }
                }
            }

            Rectangle {
                id: bubble
                x: portraitDock.x - width - 12
                y: portraitDock.y + 8
                width: 330
                height: Math.max(0, Math.min(180, portraitDock.height - 16, bubbleLabel.implicitHeight + 38))
                radius: 19
                color: "#fff1f5"
                border.color: "#f5cbd9"
                visible: root.portraitSource !== "" && root.bubbleShown && root.bubbleEnabled && !root.expanded
                clip: true
                opacity: visible ? 1 : 0
                Behavior on opacity { NumberAnimation { duration: 180 } }
                Text {
                    id: bubbleLabel
                    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 19 }
                    text: root.bubbleText
                    color: "#4b3447"
                    wrapMode: Text.Wrap
                    maximumLineCount: 6
                    elide: Text.ElideRight
                    font.pixelSize: 15
                    lineHeight: 1.3
                }
            }

            Rectangle {
                id: quickComposer
                x: Math.max(16, portraitDock.x - width - 14)
                y: panel.height - height - 32
                width: root.composeOpen && !root.expanded ? 360 : 0
                height: root.composeOpen && !root.expanded ? 56 : 0
                radius: 16
                color: "#f2232c40"
                border.color: "#a4a7b5ca"
                visible: root.composeOpen && !root.expanded
                TextField {
                    id: quickInput
                    x: 15; y: 5
                    width: 263; height: 46
                    placeholderText: root.busy ? "正在回复…" : "输入消息，Enter 发送"
                    placeholderTextColor: "#aeb8ca"
                    enabled: !root.busy
                    color: "#fff4f8"
                    font.pixelSize: 14
                    background: Item {}
                    onAccepted: root.sendQuickText()
                }
                Rectangle {
                    x: 286; y: 7; width: 66; height: 42; radius: 11
                    color: root.busy ? "#665b6d" : "#ffd5e4"
                    Text {
                        anchors.centerIn: parent
                        text: "发送"
                        color: "#352b3a"
                        font.pixelSize: 14
                        font.bold: true
                    }
                    MouseArea { anchors.fill: parent; enabled: !root.busy; cursorShape: Qt.PointingHandCursor; onClicked: root.sendQuickText() }
                }
            }

            Rectangle {
                x: portraitDock.x - width - 14
                y: panel.height - height - 34
                width: 300; height: 44; radius: 12
                visible: root.toastShown && !root.expanded && !root.composeOpen
                color: "#f1293b4c"
                border.color: "#92b6c9c0"
                Text {
                    anchors.centerIn: parent
                    text: root.toastText
                    color: "#f4fff9"
                    font.pixelSize: 13
                }
            }

            MouseArea {
                id: hoverBridge
                x: portraitDock.x - 72
                y: portraitDock.y
                width: root.actionHover && !root.expanded && root.portraitSource ? 72 : 0
                height: portraitDock.height
                hoverEnabled: true
                acceptedButtons: Qt.NoButton
                onEntered: {
                    root.actionHover = true
                    hideActionsDelay.stop()
                }
                onExited: hideActionsDelay.start()
            }

            Rectangle {
                id: actionRail
                x: portraitDock.x - width
                y: portraitDock.y + Math.max(0, (portraitDock.height - height) / 2)
                width: root.actionHover && !root.expanded && root.portraitSource ? 72 : 0
                height: root.actionHover && !root.expanded && root.portraitSource
                    ? Math.min(172, portraitDock.height) : 0
                radius: 16
                color: "#ee253044"
                border.color: "#9e9babc2"
                visible: width > 0
                MouseArea {
                    id: railPointerArea
                    anchors.fill: parent
                    hoverEnabled: true
                    acceptedButtons: Qt.NoButton
                    onEntered: {
                        root.actionHover = true
                        hideActionsDelay.stop()
                    }
                    onExited: hideActionsDelay.start()
                }
                HoverHandler {
                    onHoveredChanged: {
                        if (hovered) {
                            root.actionHover = true
                            hideActionsDelay.stop()
                        } else {
                            hideActionsDelay.start()
                        }
                    }
                }
                Column {
                    x: 8; y: 8; spacing: 6
                    Repeater {
                        model: ["输入", "截图", "隐藏"]
                        delegate: Rectangle {
                            required property string modelData
                            width: 56; height: (actionRail.height - 28) / 3; radius: 11
                            color: hovered.hovered ? "#ad536f86" : "#536478"
                            border.color: hovered.hovered ? "#d5c4d8" : "#6b8294"
                            Text { anchors.centerIn: parent; text: parent.modelData; color: "#fff5fa"; font.pixelSize: 13; font.bold: true }
                            HoverHandler {
                                id: hovered
                                onHoveredChanged: {
                                    if (hovered) {
                                        root.actionHover = true
                                        hideActionsDelay.stop()
                                    } else {
                                        hideActionsDelay.start()
                                    }
                                }
                            }
                            MouseArea {
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onEntered: {
                                    root.actionHover = true
                                    root.actionButtonHovered = true
                                    hideActionsDelay.stop()
                                }
                                onExited: {
                                    root.actionButtonHovered = false
                                    hideActionsDelay.start()
                                }
                                onClicked: {
                                    if (parent.modelData === "输入")
                                        root.openCompose()
                                    else if (parent.modelData === "截图")
                                        root.startCapture()
                                    else
                                        root.hidePet()
                                }
                            }
                        }
                    }
                }
            }

            Item {
                id: portraitDock
                x: panel.width - width - 10
                y: root.expanded ? drawer.y + drawer.height - height - 16 : panel.height - height - 12
                width: root.portraitSource ? (root.expanded ? 340 : 480) : 0
                height: root.expanded ? Math.max(0, Math.min(590, drawer.height - 130))
                    : Math.max(0, Math.min(520, panel.height / 2 - 12))
                Behavior on width { NumberAnimation { duration: 280; easing.type: Easing.OutCubic } }
                Behavior on height { NumberAnimation { duration: 280; easing.type: Easing.OutCubic } }
                HoverHandler {
                    onHoveredChanged: {
                        if (hovered) {
                            root.actionHover = true
                            hideActionsDelay.stop()
                        } else {
                            hideActionsDelay.start()
                        }
                    }
                }
                Image {
                    anchors.fill: parent
                    source: root.portraitSource
                    fillMode: Image.PreserveAspectCrop
                    verticalAlignment: Image.AlignTop
                    horizontalAlignment: Image.AlignHCenter
                    smooth: true
                }
                MouseArea {
                    id: portraitHit
                    anchors.fill: parent
                    enabled: root.portraitSource !== ""
                    hoverEnabled: true
                    acceptedButtons: Qt.LeftButton | Qt.RightButton
                    cursorShape: Qt.PointingHandCursor
                    onEntered: {
                        root.actionHover = true
                        hideActionsDelay.stop()
                    }
                    onExited: hideActionsDelay.start()
                    onClicked: mouse => {
                        if (mouse.button === Qt.RightButton) {
                            if (root.composeOpen)
                                root.composeOpen = false
                            else
                                root.openCompose()
                        } else {
                            root.toggleStage()
                        }
                    }
                }
            }
        }
    }
}
