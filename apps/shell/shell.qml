//@ pragma AppId voidmaker
//@ pragma ShellId voidmaker

import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io

ShellRoot {
    id: root
    property string status: "offline"
    property string draft: ""
    property string errorText: ""
    property string approvalId: ""
    property string approvalText: ""

    function send(command) {
        if (transport.connected) {
            transport.write(JSON.stringify(command) + "\n")
            transport.flush()
        }
    }

    function receive(line) {
        let event
        try { event = JSON.parse(line) } catch (error) { return }
        switch (event.type) {
        case "snapshot":
            if (event.version !== 1) {
                root.errorText = "界面与服务协议版本不匹配"
                return
            }
            messages.clear()
            for (const message of event.messages)
                messages.append({ role: message.role, content: message.text })
            root.status = event.status
            root.draft = event.draft || ""
            conversation.positionViewAtEnd()
            break
        case "message":
            if (event.message.role === "assistant") root.draft = ""
            messages.append({ role: event.message.role, content: event.message.text })
            conversation.positionViewAtEnd()
            break
        case "delta":
            root.draft += event.text
            conversation.positionViewAtEnd()
            break
        case "status":
            root.status = event.status
            if (event.status === "idle") root.draft = ""
            break
        case "approval":
            root.approvalId = event.requestId
            root.approvalText = event.description
            break
        case "approval_closed":
            if (root.approvalId === event.requestId) root.approvalId = ""
            break
        case "error":
            root.errorText = event.message
            break
        }
    }

    Socket {
        id: transport
        path: Quickshell.env("VOIDMAKER_SOCKET") || (Quickshell.env("XDG_RUNTIME_DIR") + "/voidmaker/host.sock")
        connected: true
        parser: SplitParser { onRead: line => root.receive(line) }
        onConnectedChanged: {
            if (connected) {
                root.errorText = ""
                root.send({ type: "hello", version: 1 })
            } else {
                root.status = "offline"
                root.approvalId = ""
            }
        }
    }

    Timer {
        interval: 2000
        repeat: true
        running: !transport.connected
        onTriggered: transport.connected = true
    }

    ListModel { id: messages }

    PanelWindow {
        id: panel
        anchors { right: true; bottom: true }
        implicitWidth: 430
        implicitHeight: 690
        color: "#171b27"
        exclusionMode: ExclusionMode.Ignore
        focusable: true

        Column {
            anchors.fill: parent
            anchors.margins: 20
            spacing: 12

            Row {
                width: parent.width
                spacing: 12
                Text { text: "VoidMaker"; color: "#f5f5fa"; font.pixelSize: 23; font.bold: true }
                Text {
                    text: root.status === "offline" ? "未连接" : root.status === "thinking" ? "思考中" : root.status === "stopping" ? "停止中" : "待命"
                    color: root.status === "offline" ? "#ee8e8e" : "#9dddbf"
                    font.pixelSize: 13
                    anchors.verticalCenter: parent.verticalCenter
                }
            }

            Rectangle { width: parent.width; height: 1; color: "#343b50" }

            ListView {
                id: conversation
                width: parent.width
                height: parent.height - 180 - (approvalBox.visible ? approvalBox.height : 0)
                clip: true
                spacing: 10
                model: messages
                delegate: Rectangle {
                    required property string role
                    required property string content
                    width: conversation.width
                    height: body.implicitHeight + 24
                    radius: 10
                    color: role === "user" ? "#344363" : "#272e3f"
                    Text {
                        id: body
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        text: parent.content
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#f1f2f7"
                        font.pixelSize: 14
                    }
                }
                footer: Rectangle {
                    width: conversation.width
                    height: root.draft ? draftText.implicitHeight + 24 : 0
                    radius: 10
                    color: "#272e3f"
                    visible: root.draft.length > 0
                    Text {
                        id: draftText
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        text: root.draft
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#f1f2f7"
                        font.pixelSize: 14
                    }
                }
            }

            Rectangle {
                id: approvalBox
                width: parent.width
                height: visible ? 190 : 0
                visible: root.approvalId.length > 0
                color: "#47393e"
                radius: 8
                Column {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 6
                    Text { text: "Codex 请求权限"; color: "#fff0e6"; font.bold: true }
                    ScrollView {
                        width: parent.width
                        height: 100
                        clip: true
                        TextArea {
                            text: root.approvalText
                            textFormat: TextEdit.PlainText
                            readOnly: true
                            wrapMode: TextEdit.Wrap
                            color: "#eee0df"
                            background: null
                        }
                    }
                    Row {
                        spacing: 8
                        Button {
                            text: "拒绝"
                            onClicked: {
                                root.send({ type: "approval", requestId: root.approvalId, decision: "decline" })
                                root.approvalId = ""
                            }
                        }
                        Button {
                            text: "允许一次"
                            onClicked: {
                                root.send({ type: "approval", requestId: root.approvalId, decision: "accept" })
                                root.approvalId = ""
                            }
                        }
                    }
                }
            }

            Text {
                width: parent.width
                height: root.errorText ? 34 : 0
                visible: root.errorText.length > 0
                text: root.errorText
                color: "#f5a5a5"
                elide: Text.ElideRight
            }

            Row {
                width: parent.width
                spacing: 8
                Rectangle {
                    width: parent.width - sendButton.width - stopButton.width - 16
                    height: 42
                    radius: 8
                    color: "#30394e"
                    TextInput {
                        id: input
                        anchors.fill: parent
                        anchors.margins: 10
                        color: "#ffffff"
                        font.pixelSize: 14
                        clip: true
                        enabled: root.status === "idle"
                        Keys.onReturnPressed: {
                            if (input.text.trim()) {
                                root.send({ type: "send", text: input.text.trim() })
                                input.text = ""
                            }
                        }
                    }
                }
                Button {
                    id: sendButton
                    text: "发送"
                    enabled: root.status === "idle" && input.text.trim().length > 0
                    onClicked: {
                        root.send({ type: "send", text: input.text.trim() })
                        input.text = ""
                    }
                }
                Button {
                    id: stopButton
                    text: "停止"
                    enabled: root.status === "thinking"
                    onClicked: root.send({ type: "stop" })
                }
            }
        }
    }
}
