//@ pragma AppId voidmaker
//@ pragma ShellId voidmaker
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import Quickshell.Io

ShellRoot {
    id: root
    property bool interfaceVisible: true
    property bool settingsBusy: false
    property string status: "offline"
    property string draft: ""
    property string errorText: ""
    property string approvalId: ""
    property string approvalText: ""
    property var desktop: null
    property var voice: null
    property var character: null
    property string sessionId: ""
    readonly property bool characterReady: !!character && !character.changing && character.sessionId === sessionId
    readonly property bool canSend: status === "idle" && !settingsBusy && characterReady && (!voice || ["idle", "review"].includes(voice.phase))

    function setVisibility(value) {
        if(!value && interfaceVisible) send({type:"stop"})
        interfaceVisible = value
        send({type:"desktop_presence",idle:!value || activity.isIdle})
    }
    function openPage(page) {
        const pages = {chat: 0, desktop: 1, work: 2, history: 3, settings: 4, diagnostics: 4}
        if (pages[page] === undefined) return
        root.setVisibility(true)
        tabs.currentIndex = pages[page]
        if (page === "settings" || page === "diagnostics")
            settingsPanel.currentSection = page === "diagnostics" ? 1 : 0
    }
    IpcHandler {
        target: "voidmaker"
        function toggle(): void { root.setVisibility(!root.interfaceVisible) }
        function showUi(): void { root.setVisibility(true) }
        function hideUi(): void { root.setVisibility(false) }
        function settings(): void { root.openPage("settings") }
        function visible(): bool { return root.interfaceVisible }
    }
    function send(command) {
        if (transport.connected) {
            errorText = ""
            transport.send(command)
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
        workPanel.receive(event)
        settingsPanel.receive(event)
        // Process snapshot after updating connection and selection bindings below.
        if (event.type !== "snapshot") historyPanel.receive(event)
        switch (event.type) {
        case "settings": settingsBusy = event.settings.busy; break
        case "shell_visibility":
            if (event.action === "show") root.openPage(event.page)
            else if (event.action === "toggle") root.setVisibility(!root.interfaceVisible)
            break
        case "snapshot":
            if (event.version !== 8) { errorText = "界面与服务协议版本不匹配"; return }
            if (sessionId !== event.sessionId) input.text = ""
            sessionId = event.sessionId
            character = event.character
            messages.clear()
            for (const message of event.messages) messages.append({ role: message.role, content: message.text })
            status = event.status
            draft = event.draft || ""
            setVoice(event.voice)
            conversation.positionViewAtEnd()
            historyPanel.receive(event)
            break
        case "desktop": root.desktop = event.desktop; root.send({type: "desktop_presence", idle: !root.interfaceVisible || activity.isIdle}); break
        case "voice": setVoice(event.voice); break
        case "character": character = event.character; break
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
    HostConnection {
        id: transport
        path: Quickshell.env("VOIDMAKER_SOCKET") || (Quickshell.env("XDG_RUNTIME_DIR") + "/voidmaker/host.sock")
        onMessage: line => root.receive(line)
        onConnectedChanged: {
            if (connected) { root.errorText = ""; root.send({ type: "hello", version: 8 }); if (workPanel.selectedId) root.send({type: "work_get", id: workPanel.selectedId}) }
            else { root.status = "offline"; root.approvalId = ""; root.voice = null; root.desktop = null }
        }
    }
    IdleMonitor { id: activity; timeout: 300; enabled: !!root.desktop && root.desktop.policy.proactive
        onIsIdleChanged: root.send({type: "desktop_presence", idle: !root.interfaceVisible || isIdle}) }
    ListModel { id: messages }

    PanelWindow {
        visible: root.interfaceVisible
        anchors { left: true; bottom: true }
        margins { left: 16; bottom: 16 }
        implicitWidth: 280; implicitHeight: 490
        color: "transparent"
        exclusionMode: ExclusionMode.Ignore
        focusable: false
        mask: Region {}
        CharacterView { anchors.fill: parent; snapshot: root.character; online: transport.connected }
    }

    PanelWindow {
        visible: root.interfaceVisible
        anchors { right: true; bottom: true }
        implicitWidth: 540
        implicitHeight: 860
        color: "#171b27"
        exclusionMode: ExclusionMode.Ignore
        focusable: true
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 20
            spacing: 12
            RowLayout {
                Layout.fillWidth: true
                Button { text: "隐藏"; onClicked: root.setVisibility(false) }
                Text { text: "VoidMaker"; color: "#f5f5fa"; font.pixelSize: 23; font.bold: true }
                Text { text: root.status === "offline" ? "未连接" : root.status === "stopping" ? "停止中"
                    : root.status === "thinking" ? "回复中" : "待命"; color: "#9dddbf" }
                ComboBox {
                    Layout.fillWidth: true
                    model: root.character ? root.character.characters : []
                    textRole: "name"; valueRole: "id"
                    currentIndex: root.character ? root.character.characters.findIndex(c => c.id === root.character.selectedId) : -1
                    enabled: root.status === "idle" && !root.settingsBusy && root.characterReady
                        && !!root.voice && root.voice.phase === "idle" && !root.voice.continuous
                    onActivated: root.send({type: "character_select", id: currentValue})
                }
            }
            Label {
                Layout.fillWidth: true
                visible: !!root.character && (root.character.changing || root.character.warnings.length > 0)
                text: root.character && root.character.changing ? "正在更新对话上下文…"
                    : root.character ? root.character.warnings.join("\n") : ""
                color: "#dccb9a"; wrapMode: Text.Wrap; textFormat: Text.PlainText
                maximumLineCount: 2; elide: Text.ElideRight
            }
            Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: "#343b50" }
            TabBar {
                id: tabs
                Layout.fillWidth: true
                TabButton { text: "对话" }
                TabButton { text: "桌面" + (root.desktop && root.desktop.suggestion ? " · 建议" : "") }
                TabButton { text: "后台任务" + (workPanel.works.some(w => w.status === "awaiting_permission") ? " · 待审批" : "") }
                TabButton { text: "会话" }
                TabButton { text: "设置" }
            }
            SettingsPanel {
                id: settingsPanel
                Layout.fillWidth: true; Layout.fillHeight: true
                visible: tabs.currentIndex === 4
                online: root.status !== "offline"
                canEdit: root.status === "idle" && root.characterReady && !!root.voice && root.voice.phase === "idle" && !root.voice.continuous
                onCommand: value => root.send(value)
            }
            HistoryPanel {
                id: historyPanel
                Layout.fillWidth: true; Layout.fillHeight: true
                visible: tabs.currentIndex === 3
                online: root.status !== "offline"
                canEdit: root.status === "idle" && !root.settingsBusy && root.characterReady && !!root.voice && root.voice.phase === "idle" && !root.voice.continuous
                onCommand: value => root.send(value)
            }
            DesktopPanel {
                Layout.fillWidth: true; Layout.fillHeight: true
                visible: tabs.currentIndex === 1; snapshot: root.desktop
                online: root.status !== "offline"; canSend: root.canSend
                onCommand: value => { root.send(value); if (value.type === "desktop_send") tabs.currentIndex = 0 }
            }
            WorkPanel {
                id: workPanel
                Layout.fillWidth: true; Layout.fillHeight: true
                visible: tabs.currentIndex === 2
                online: root.status !== "offline"
                onCommand: value => root.send(value)
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.fillHeight: true
                visible: tabs.currentIndex === 0
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
                Button {
                    text: "将输入转为任务草稿"
                    enabled: input.text.trim().length > 0
                    onClicked: { workPanel.useTranscript(input.text.trim()); tabs.currentIndex = 2 }
                }
                VoiceControls {
                    Layout.fillWidth: true
                    snapshot: root.voice
                    chatIdle: root.status === "idle" && !root.settingsBusy && root.characterReady
                    onCommand: value => root.send(value)
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
            Text {
                Layout.fillWidth: true
                visible: root.errorText.length > 0
                text: root.errorText
                textFormat: Text.PlainText
                color: "#f5a5a5"
                wrapMode: Text.Wrap
                maximumLineCount: 3
            }
        }
    }
}
