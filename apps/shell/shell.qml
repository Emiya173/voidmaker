//@ pragma AppId voidmaker
//@ pragma ShellId voidmaker
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io

ShellRoot {
    id: root
    property string status: "offline"
    property string draft: ""
    property string errorText: ""
    property string approvalId: ""
    property string approvalText: ""
    property var voice: null
    readonly property bool canSend: status === "idle" && (!voice || ["idle", "review"].includes(voice.phase))

    function send(command) {
        if (transport.connected) {
            errorText = ""
            transport.write(JSON.stringify(command) + "\n")
            transport.flush()
        }
    }
    function setVoice(value) {
        if (value.phase === "review" && !value.continuous
            && (!voice || voice.phase !== "review" || voice.generation !== value.generation))
            input.text = value.transcript
        voice = value
    }
    function submit() {
        if (canSend && input.text.trim()) {
            send({ type: "send", text: input.text.trim() })
            input.text = ""
        }
    }
    function receive(line) {
        let event
        try { event = JSON.parse(line) } catch (error) { return }
        switch (event.type) {
        case "snapshot":
            if (event.version !== 2) { errorText = "界面与服务协议版本不匹配"; return }
            messages.clear()
            for (const message of event.messages) messages.append({ role: message.role, content: message.text })
            status = event.status
            draft = event.draft || ""
            setVoice(event.voice)
            conversation.positionViewAtEnd()
            break
        case "voice": setVoice(event.voice); break
        case "message":
            if (event.message.role === "assistant") draft = ""
            messages.append({ role: event.message.role, content: event.message.text })
            conversation.positionViewAtEnd()
            break
        case "delta": draft += event.text; conversation.positionViewAtEnd(); break
        case "status": status = event.status; if (status === "idle") draft = ""; break
        case "approval": approvalId = event.requestId; approvalText = event.description; break
        case "approval_closed": if (approvalId === event.requestId) approvalId = ""; break
        case "error": errorText = event.message; break
        }
    }
    Socket {
        id: transport
        path: Quickshell.env("VOIDMAKER_SOCKET") || (Quickshell.env("XDG_RUNTIME_DIR") + "/voidmaker/host.sock")
        connected: true
        parser: SplitParser { onRead: line => root.receive(line) }
        onConnectedChanged: {
            if (connected) { root.errorText = ""; root.send({ type: "hello", version: 2 }) }
            else { root.status = "offline"; root.approvalId = ""; root.voice = null }
        }
    }
    Timer { interval: 2000; repeat: true; running: !transport.connected; onTriggered: transport.connected = true }
    ListModel { id: messages }

    PanelWindow {
        anchors { right: true; bottom: true }
        implicitWidth: 470
        implicitHeight: 760
        color: "#171b27"
        exclusionMode: ExclusionMode.Ignore
        focusable: true
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 20
            spacing: 12
            RowLayout {
                Layout.fillWidth: true
                Text { text: "VoidMaker"; color: "#f5f5fa"; font.pixelSize: 23; font.bold: true }
                Text { text: root.status === "offline" ? "未连接" : root.status === "stopping" ? "停止中"
                    : root.status === "thinking" ? "回复中" : "待命"; color: "#9dddbf" }
            }
            Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: "#343b50" }
            ListView {
                id: conversation
                Layout.fillWidth: true
                Layout.fillHeight: true
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
                Layout.fillWidth: true
                implicitHeight: 190
                visible: root.approvalId.length > 0
                color: "#47393e"
                radius: 8
                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    Text { text: "Codex 请求权限"; color: "#fff0e6"; font.bold: true }
                    ScrollView {
                        Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                        TextArea { text: root.approvalText; textFormat: TextEdit.PlainText; readOnly: true
                            wrapMode: TextEdit.Wrap; color: "#eee0df"; background: null }
                    }
                    RowLayout {
                        Button { text: "拒绝"; onClicked: root.send({ type: "approval", requestId: root.approvalId, decision: "decline" }) }
                        Button { text: "允许一次"; onClicked: root.send({ type: "approval", requestId: root.approvalId, decision: "accept" }) }
                    }
                }
            }
            VoiceControls {
                Layout.fillWidth: true
                snapshot: root.voice
                chatIdle: root.status === "idle"
                onCommand: value => root.send(value)
            }
            Text {
                Layout.fillWidth: true
                visible: root.errorText.length > 0
                text: root.errorText
                textFormat: Text.PlainText
                color: "#f5a5a5"
                wrapMode: Text.Wrap
                maximumLineCount: 3
            }
            RowLayout {
                Layout.fillWidth: true
                ScrollView {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 66
                    TextArea {
                        id: input
                        placeholderText: "输入文字或更正转写"
                        textFormat: TextEdit.PlainText
                        wrapMode: TextEdit.Wrap
                        enabled: root.canSend
                        Keys.onReturnPressed: event => {
                            if (!(event.modifiers & Qt.ShiftModifier)) { root.submit(); event.accepted = true }
                            else event.accepted = false
                        }
                    }
                }
                Button { text: "发送"; enabled: root.canSend && input.text.trim().length > 0; onClicked: root.submit() }
                Button {
                    text: "停止"
                    enabled: root.status === "thinking" || (!!root.voice && root.voice.phase !== "idle")
                    onClicked: root.send({ type: "stop" })
                }
            }
        }
    }
}
