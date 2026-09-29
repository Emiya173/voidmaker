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
    property bool immersive: false
    property bool companionExpanded: false
    property bool logVisible: true
    property bool useModel: false
    property bool continuous: false
    property string drawerPage: ""
    property bool settingsBusy: false
    property bool ready: false
    property string status: "offline"
    property string draft: ""
    property string reply: ""
    property string errorText: ""
    property string approvalId: ""
    property string approvalText: ""
    property var desktop: null
    property var voice: null
    property var character: null
    property string sessionId: ""
    readonly property string phase: voice ? voice.phase : "idle"
    readonly property bool characterReady: !!character && !character.changing && character.sessionId === sessionId
    readonly property bool canSend: ready && transport.connected && status === "idle" && !settingsBusy && characterReady && ["idle", "review"].includes(phase)
    readonly property bool canEditContext: canSend && phase === "idle" && (!voice || !voice.continuous)
    readonly property bool busy: status === "thinking" || status === "stopping" || !["idle", "review"].includes(phase)
    readonly property bool hasTranscript: composer.generation >= 0
    readonly property bool chatOpen: immersive || companionExpanded
    readonly property bool canListen: canSend && !!voice && voice.inputAvailable && !hasTranscript
    readonly property string phaseLabel: !transport.connected ? "未连接" : !ready ? "连接中…" : character && character.changing ? "切换中…"
        : ({preparing: "准备录音…", listening: "录音中", transcribing: "识别中…", interrupting: "正在打断…", thinking: "思考中…", synthesizing: "准备语音…", speaking: "回应中", stopping: "停止中…"})[phase] || (status === "thinking" ? "思考中…" : "")
    readonly property string notice: errorText || (voice ? voice.error : "") || (art.modelError ? "3D 加载失败，当前显示立绘" : "")

    Theme { id: theme }
    ComposerBuffer { id: composer; onCommand: value => root.send(value) }
    ListModel { id: messages }
    Timer { id: replyDelay; interval: 5000; onTriggered: root.reply = "" }

    function setVisibility(value) {
        if (!value && interfaceVisible) { send({type: "stop"}); replyDelay.stop(); reply = "" }
        interfaceVisible = value
        send({type: "desktop_presence", idle: !value || activity.isIdle})
    }
    function openPage(page) {
        if (!["chat", "desktop", "work", "history", "settings", "diagnostics"].includes(page)) return
        setVisibility(true)
        if (page === "chat") { drawerPage = ""; companionExpanded = true; Qt.callLater(() => input.focusEditor()) }
        else {
            drawerPage = page === "diagnostics" ? "settings" : page
            if (page === "settings" || page === "diagnostics") settingsPanel.currentSection = page === "diagnostics" ? 1 : 0
        }
    }
    function toggleChat() {
        companionExpanded = drawerPage ? true : !companionExpanded
        drawerPage = ""
        if (companionExpanded) Qt.callLater(() => input.focusEditor())
        else dockChat.forceActiveFocus()
    }
    function togglePage(page) {
        if (drawerPage === page) drawerPage = ""
        else openPage(page)
    }
    function toggleImmersive() {
        immersive = !immersive; drawerPage = ""
        if (immersive || companionExpanded) Qt.callLater(() => input.focusEditor())
        else dockExpand.forceActiveFocus()
    }
    function send(command) {
        if (transport.connected) transport.send(command)
    }
    function submit(source) {
        if (!canSend || !(source === "transcript" ? composer.transcript : composer.text).trim()) return
        errorText = ""; composer.send(source)
    }
    function microphone() {
        errorText = ""
        if (phase === "listening") send({type: "voice_finish"})
        else if (canListen) send({type: "voice_start", continuous})
    }
    function stop() { replyDelay.stop(); reply = ""; send({type: "stop"}) }
    function sentence(text) {
        const clean = text.replace(/```[\s\S]*?```/g, "代码已显示在对话中。").replace(/[*#`]/g, "").trim()
        const parts = clean.match(/[^。！？!?\n]{1,180}[。！？!?\n]?/g) || []
        return parts.length ? parts[parts.length - 1].trim() : ""
    }
    function setVoice(value) {
        const previous = phase
        voice = value
        if (value.subtitle) { replyDelay.stop(); reply = value.subtitle }
        if (["listening", "preparing", "stopping"].includes(value.phase)) { replyDelay.stop(); reply = "" }
        if (value.phase === "review" && !value.continuous) continuous = false
        if (value.phase === "idle" && previous !== "idle" && status === "idle" && reply) replyDelay.restart()
    }
    function receive(line) {
        let event
        try { event = JSON.parse(line) } catch (_) { return }
        workPanel.receive(event); settingsPanel.receive(event)
        if (event.type !== "snapshot") historyPanel.receive(event)
        switch (event.type) {
        case "settings": settingsBusy = event.settings.busy; break
        case "shell_visibility":
            if (event.action === "show") openPage(event.page)
            else if (event.action === "toggle") setVisibility(!interfaceVisible)
            break
        case "snapshot": {
            if (event.version !== 10) { ready = false; errorText = "界面与服务协议版本不匹配，请同时重启 Host 与界面"; return }
            const changed = sessionId !== event.sessionId
            if (changed) { reply = ""; replyDelay.stop(); conversation.followTail = true }
            sessionId = event.sessionId; character = event.character; status = event.status; ready = true
            composer.receive(sessionId, event.composer, "", true)
            messages.clear()
            for (const message of event.messages) messages.append({role: message.role, content: message.text})
            draft = event.draft || ""; setVoice(event.voice)
            conversation.changed(); historyPanel.receive(event)
            break
        }
        case "composer":
            if (event.sessionId === sessionId) composer.receive(sessionId, event.composer, event.requestId || "", false)
            break
        case "desktop": desktop = event.desktop; send({type: "desktop_presence", idle: !interfaceVisible || activity.isIdle}); break
        case "voice": setVoice(event.voice); break
        case "character": character = event.character; break
        case "message":
            if (event.message.role === "assistant") { draft = ""; reply = sentence(event.message.text); if (status === "idle") replyDelay.restart() }
            messages.append({role: event.message.role, content: event.message.text}); conversation.changed()
            break
        case "delta": draft += event.text; replyDelay.stop(); reply = sentence(draft); break
        case "status":
            status = event.status
            if (status === "thinking") { replyDelay.stop(); reply = "" }
            if (status === "stopping") { replyDelay.stop(); reply = "" }
            if (status === "idle") { draft = ""; if (reply) replyDelay.restart() }
            break
        case "approval": approvalId = event.requestId; approvalText = event.description; break
        case "approval_closed": if (approvalId === event.requestId) approvalId = ""; break
        case "error": errorText = event.message; break
        }
    }
    IpcHandler {
        target: "voidmaker"
        function toggle(): void { root.setVisibility(!root.interfaceVisible) }
        function showUi(): void { root.setVisibility(true) }
        function hideUi(): void { root.setVisibility(false) }
        function settings(): void { root.openPage("settings") }
        function visible(): bool { return root.interfaceVisible }
    }
    HostConnection {
        id: transport
        path: Quickshell.env("VOIDMAKER_SOCKET") || (Quickshell.env("XDG_RUNTIME_DIR") + "/voidmaker/host.sock")
        onMessage: line => root.receive(line)
        onConnectedChanged: {
            root.ready = false
            if (connected) {
                root.errorText = ""; root.send({type: "hello", version: 10})
                if (workPanel.selectedId) root.send({type: "work_get", id: workPanel.selectedId})
            } else {
                root.status = "offline"; root.approvalId = ""; root.voice = null; root.desktop = null
                root.reply = ""; replyDelay.stop()
            }
        }
    }
    IdleMonitor {
        id: activity; timeout: 300; enabled: !!root.desktop && root.desktop.policy.proactive
        onIsIdleChanged: root.send({type: "desktop_presence", idle: !root.interfaceVisible || isIdle})
    }

    PanelWindow {
        id: window
        visible: root.interfaceVisible
        anchors { right: true; bottom: true }
        margins { right: 16; bottom: 16 }
        // A stable surface prevents compositor resize flashes when cards open.
        implicitWidth: Math.min(root.immersive ? 1160 : 940, (screen ? screen.width : 1440) - 32)
        implicitHeight: Math.min(root.immersive ? 800 : 720, (screen ? screen.height : 960) - 32)
        color: "transparent"
        exclusionMode: ExclusionMode.Ignore
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.OnDemand
        // Only controls own pointer input. The character and unused transparent space pass through.
        mask: Region {
            Region { item: dock.visible ? dock : null }
            Region { item: chat.visible && !drawer.visible ? chat : null }
            Region { item: compactTranscript.visible && !drawer.visible ? compactTranscript : null }
            Region { item: heading.visible ? heading : null }
            Region { item: noticeCard.visible && !drawer.visible ? noticeCard : null }
            Region { item: approval.visible ? approval : null }
            Region { item: drawer.visible ? drawer : null }
        }
        Pane {
            id: stage
            anchors.fill: parent
            padding: 0; background: null
            palette {
                window: theme.log; windowText: theme.text; base: theme.input; text: theme.text
                button: theme.assistant; buttonText: theme.text; highlight: theme.pink; highlightedText: theme.log
                placeholderText: theme.muted
                mid: theme.line; light: theme.line; dark: theme.input
            }
            readonly property bool narrow: width < 640
            Rectangle { anchors.fill: parent; visible: root.immersive; color: theme.background; radius: 8 }
            Item {
                visible: root.immersive; clip: true
                x: 0; y: 0; width: stage.narrow ? stage.width : stage.width * 0.46; height: stage.height
                Rectangle { x: -90; y: parent.height * 0.27; width: parent.width + 150; height: parent.height * 0.58; rotation: -12; color: theme.stage }
                Rectangle { x: -30; y: parent.height * 0.74; width: parent.width + 70; height: 20; rotation: -12; color: theme.pink }
                Repeater { model: 72
                    Rectangle { required property int index; x: 22 + (index % 8) * 14; y: 70 + Math.floor(index / 8) * 14
                        width: 2; height: 2; radius: 1; color: "#71847e"; opacity: 0.35 }
                }
            }
            CharacterView {
                id: art
                x: root.immersive ? 12 : stage.width - width - 2
                y: root.immersive ? 72 : stage.height - height - 58
                width: root.immersive ? (stage.narrow ? stage.width * 0.42 : stage.width * 0.44) : Math.min(320, stage.width * 0.62)
                height: root.immersive ? (stage.narrow ? 220 : stage.height - 165) : stage.narrow ? 240 : Math.min(610, stage.height - 88)
                snapshot: root.character; online: transport.connected; windowVisible: root.interfaceVisible
                useModel: root.useModel
            }
            ReplyBubble {
                id: replyBubble
                visible: !!root.reply && !drawer.visible && (!root.chatOpen || root.immersive)
                width: root.immersive ? (stage.narrow ? stage.width * 0.5 : art.width - 30) : Math.min(270, stage.width - art.width + 40)
                x: root.immersive ? (stage.narrow ? stage.width - width - 12 : 28) : Math.max(6, art.x - width + 36)
                y: root.immersive ? (stage.narrow ? 110 : stage.height - height - 24) : Math.max(22, art.y + 66)
                height: implicitHeight; text: root.reply; tail: !root.immersive
            }
            RowLayout {
                id: heading
                visible: root.immersive
                x: 18; y: 12; width: parent.width - 36; height: 44
                IconButton { glyph: "back"; label: "回到陪伴"; onClicked: root.toggleImmersive() }
                ComboBox {
                    Layout.maximumWidth: 220; Layout.fillWidth: true
                    popup.popupType: Popup.Window
                    model: root.character ? root.character.characters : []; textRole: "name"; valueRole: "id"
                    currentIndex: root.character ? root.character.characters.findIndex(c => c.id === root.character.selectedId) : -1
                    enabled: root.canEditContext
                    onActivated: root.send({type: "character_select", id: currentValue})
                }
                IconButton { glyph: root.useModel ? "cube" : "image"; label: root.useModel ? "切换立绘" : (art.modelAvailable ? "切换 3D 模型" : "角色未配置 3D 模型")
                    enabled: art.modelAvailable; selected: root.useModel; onClicked: root.useModel = !root.useModel }
                Item { Layout.fillWidth: true }
                IconButton { visible: !stage.narrow; glyph: "history"; label: "会话与记忆"; selected: root.drawerPage === "history"; onClicked: root.togglePage("history") }
                IconButton { glyph: "work"; label: "后台任务"; selected: root.drawerPage === "work"; onClicked: root.togglePage("work") }
                IconButton { visible: !stage.narrow; glyph: "settings"; label: "设置"; selected: root.drawerPage === "settings"; onClicked: root.togglePage("settings") }
                IconButton { visible: !stage.narrow; glyph: "hide"; label: "隐藏并停止当前对话"; onClicked: root.setVisibility(false) }
            }

            CutPanel {
                id: chat
                visible: root.chatOpen && !drawer.visible
                x: root.immersive ? (stage.narrow ? 12 : stage.width * 0.47) : stage.narrow ? 12 : art.x - width - 18
                y: root.immersive ? (stage.narrow ? 305 : 72) : stage.narrow ? 12 : stage.height - height - 80
                width: root.immersive ? (stage.narrow ? stage.width - 24 : stage.width * 0.53 - 18) : stage.narrow ? stage.width - 24 : Math.min(338, art.x - 30)
                height: root.immersive ? stage.height - (stage.narrow ? 305 : 72) - 18 : stage.narrow ? art.y - 28 : Math.min(560, stage.height - 115)
                color: theme.log; borderColor: theme.line
                ColumnLayout {
                    anchors { fill: parent; margins: 14 } spacing: 10
                    RowLayout {
                        Layout.fillWidth: true
                        Label { text: art.name; visible: !root.immersive; color: theme.pink; font.pixelSize: 16; font.bold: true; Layout.fillWidth: true }
                        IconButton { glyph: "chat"; label: root.logVisible ? "收起记录" : "展开记录"; selected: root.logVisible; onClicked: root.logVisible = !root.logVisible }
                        Item { visible: root.immersive; Layout.fillWidth: true }
                        IconButton { visible: !root.immersive; glyph: root.useModel ? "cube" : "image"; label: root.useModel ? "切换立绘" : "切换 3D 模型"; enabled: art.modelAvailable
                            onClicked: root.useModel = !root.useModel }
                        IconButton { glyph: "history"; label: "会话与记忆"; selected: root.drawerPage === "history"; onClicked: root.togglePage("history") }
                        IconButton { visible: !root.immersive || stage.narrow; glyph: "settings"; label: "设置"; selected: root.drawerPage === "settings"; onClicked: root.togglePage("settings") }
                        IconButton { visible: !root.immersive; glyph: "close"; label: "收起文字卡"; onClicked: root.toggleChat() }
                    }
                    MessageLog { id: conversation; Layout.fillWidth: true; Layout.fillHeight: true
                        visible: root.logVisible; model: messages; draft: root.draft }
                    Item { visible: !root.logVisible; Layout.fillHeight: true }
                    TranscriptCard {
                        id: expandedTranscript
                        visible: root.hasTranscript
                        Layout.fillWidth: true; Layout.preferredHeight: implicitHeight
                        value: composer.transcript; expanded: true; conflict: !!composer.text.trim() || !!composer.desktopId
                        canSend: root.canSend
                        onEdited: value => composer.edit("transcript", value)
                        onSubmitted: root.submit("transcript")
                        onResolve: action => composer.resolve(action)
                        onEscaped: input.focusEditor()
                    }
                    RowLayout {
                        visible: !!composer.desktopId
                        Glyph { name: "image"; ink: theme.mint; Layout.preferredWidth: 16; Layout.preferredHeight: 16 }
                        Label { text: "桌面上下文"; color: theme.mint; Layout.fillWidth: true }
                        IconButton { glyph: "close"; label: "移除附加内容"; implicitHeight: 26; implicitWidth: 26; onClicked: composer.attach(null) }
                    }
                    Rectangle {
                        Layout.fillWidth: true; Layout.preferredHeight: input.implicitHeight + 52
                        color: theme.input; border.color: input.editor.activeFocus ? theme.pink : theme.line; radius: 3
                        ColumnLayout {
                            anchors { fill: parent; margins: 5 } spacing: 0
                            TextEntry { id: input; Layout.fillWidth: true; Layout.fillHeight: true
                                value: composer.text; minimumHeight: 52; maximumHeight: root.immersive ? 120 : 72
                                onEdited: value => composer.edit("text", value)
                                onSubmitted: root.submit("text")
                                onEscaped: dockChat.forceActiveFocus()
                            }
                            RowLayout {
                                Layout.fillWidth: true
                                IconButton { glyph: "plus"; label: "附加桌面上下文"; selected: root.drawerPage === "desktop"; onClicked: root.togglePage("desktop") }
                                IconButton { glyph: "loop"; label: root.continuous ? "关闭连续语音" : "连续语音：转写后自动发送"; selected: root.continuous
                                    enabled: !root.busy && !root.hasTranscript && !composer.text.trim() && !composer.desktopId
                                    onClicked: root.continuous = !root.continuous }
                                IconButton { glyph: "work"; label: "将文字转为任务草稿"; enabled: !!composer.text.trim()
                                    onClicked: { workPanel.useTranscript(composer.text); root.openPage("work") } }
                                Item { Layout.fillWidth: true }
                                IconButton { glyph: root.phase === "listening" ? "check" : "mic"; label: root.phase === "listening" ? "结束说话" : "开始说话"
                                    enabled: root.phase === "listening" || root.canListen; onClicked: root.microphone() }
                                IconButton { glyph: root.busy ? "stop" : "send"; label: root.busy ? "停止当前对话" : "发送文字"; selected: true
                                    enabled: root.busy || (root.canSend && !!composer.text.trim()); onClicked: root.busy ? root.stop() : root.submit("text") }
                            }
                        }
                    }
                }
            }

            Rectangle {
                id: dock
                visible: !root.immersive
                width: 228; height: 52
                x: art.x + (art.width - width) / 2; y: stage.height - height - 4
                radius: 5; color: "#f0202d30"; border.color: "#655367"
                Grid {
                    anchors.centerIn: parent; columns: 5; spacing: 4
                    IconButton { id: dockChat; glyph: "chat"; label: root.companionExpanded && !root.drawerPage ? "收起文字卡" : "文字交流"; selected: root.companionExpanded && !root.drawerPage; onClicked: root.toggleChat() }
                    IconButton { glyph: root.phase === "listening" ? "check" : "mic"; label: root.phase === "listening" ? "结束说话" : (root.voice && root.voice.inputAvailable ? "开始说话" : "请在设置中配置 ASR")
                        enabled: root.phase === "listening" || root.canListen; selected: root.phase === "listening"; onClicked: root.microphone() }
                    IconButton { glyph: root.busy ? "stop" : "send"; label: root.busy ? "停止当前对话" : "发送转写"; accent: theme.mint
                        enabled: root.busy || (root.canSend && root.hasTranscript && !!composer.transcript.trim()); onClicked: root.busy ? root.stop() : root.submit("transcript") }
                    IconButton { id: dockWork; glyph: "work"; label: root.drawerPage === "work" ? "收起后台任务" : "后台任务"; selected: root.drawerPage === "work"; onClicked: root.togglePage("work") }
                    IconButton { id: dockExpand; glyph: "expand"; label: "沉浸交流"; onClicked: root.toggleImmersive() }
                }
            }
            TranscriptCard {
                id: compactTranscript
                visible: root.hasTranscript && !root.chatOpen && !drawer.visible
                width: Math.min(300, dock.x - 16); height: implicitHeight
                x: dock.x - width - 12; y: dock.y + dock.height - height
                value: composer.transcript; canSend: root.canSend
                onEdited: value => composer.edit("transcript", value)
                onSubmitted: root.submit("transcript")
                onResolve: action => composer.resolve(action)
                onEscaped: dockChat.forceActiveFocus()
            }
            Rectangle {
                id: noticeCard
                visible: !!root.notice || !!root.phaseLabel
                x: root.immersive ? chat.x : dock.x; width: root.immersive ? chat.width : dock.width
                y: root.immersive ? Math.max(60, chat.y - height - 4) : dock.y - height - 8
                height: noticeBody.implicitHeight + 16; radius: 4
                color: theme.panel; border.color: root.notice ? theme.warning : theme.line
                ColumnLayout { id: noticeBody; anchors { left: parent.left; right: parent.right; top: parent.top; margins: 8 } spacing: 4
                    Label { Layout.fillWidth: true; visible: !!root.phaseLabel; text: root.phaseLabel + (root.voice && root.voice.continuous && root.voice.aecAvailable ? " · 麦克风开启" : "")
                        color: root.phase === "listening" ? theme.mint : theme.muted; font.pixelSize: 12; wrapMode: Text.Wrap }
                    Rectangle { Layout.fillWidth: true; height: 3; visible: root.phase === "listening"; color: "#35524f"
                        Rectangle { height: 3; width: parent.width * Math.min(1, (root.voice ? root.voice.level : 0) * 8); color: theme.mint } }
                    Label { Layout.fillWidth: true; visible: !!root.notice; text: root.notice; color: theme.warning; font.pixelSize: 12; wrapMode: Text.Wrap; maximumLineCount: 5; elide: Text.ElideRight }
                    IconButton { visible: !!root.errorText; glyph: "close"; label: "关闭提示"; implicitHeight: 24; implicitWidth: 24; onClicked: root.errorText = "" }
                }
            }

            Rectangle {
                id: drawer
                visible: !!root.drawerPage
                x: root.immersive ? (stage.narrow ? 12 : stage.width * 0.47) : 0
                width: stage.narrow ? stage.width - x * 2 : root.immersive ? stage.width - x - 12 : Math.min(570, art.x - 18)
                height: root.immersive ? stage.height - y - 18 : stage.narrow ? art.y - 12 : stage.height
                y: root.immersive ? (stage.narrow ? 305 : 72) : 0
                color: theme.log; border.color: theme.line; radius: 5
                ColumnLayout {
                    anchors { fill: parent; margins: 18 } spacing: 12
                    RowLayout {
                        Label { text: ({work: "后台任务", desktop: "桌面上下文", history: "会话与记忆", settings: "设置"})[root.drawerPage] || ""; color: theme.pink; font.pixelSize: 20; Layout.fillWidth: true }
                        IconButton { glyph: "close"; label: "关闭面板"; onClicked: root.drawerPage = "" }
                    }
                    Label {
                        Layout.fillWidth: true
                        visible: root.drawerPage === "settings" && !!root.character && root.character.warnings.length > 0
                        text: visible ? root.character.warnings.join("\n") : ""
                        textFormat: Text.PlainText; wrapMode: Text.Wrap; color: theme.warning
                    }
                    SettingsPanel { id: settingsPanel; visible: root.drawerPage === "settings"; Layout.fillWidth: true; Layout.fillHeight: true
                        online: transport.connected; canEdit: root.canEditContext; onCommand: value => root.send(value) }
                    HistoryPanel { id: historyPanel; visible: root.drawerPage === "history"; Layout.fillWidth: true; Layout.fillHeight: true
                        online: transport.connected; canEdit: root.canEditContext; onCommand: value => root.send(value) }
                    DesktopPanel { id: desktopPanel; visible: root.drawerPage === "desktop"; Layout.fillWidth: true; Layout.fillHeight: true
                        snapshot: root.desktop; online: transport.connected; canSend: root.canSend
                        onCommand: value => { root.send(value); if (value.type === "desktop_send") root.openPage("chat") }
                        onAttach: id => { composer.attach(id); root.openPage("chat") }
                    }
                    WorkPanel { id: workPanel; visible: root.drawerPage === "work"; Layout.fillWidth: true; Layout.fillHeight: true
                        online: transport.connected; onCommand: value => root.send(value) }
                }
            }
            Rectangle {
                id: approval
                visible: !!root.approvalId
                x: Math.max(0, stage.width - width); y: Math.max(0, stage.height / 2 - height / 2)
                width: Math.min(480, stage.width); height: Math.min(340, stage.height)
                color: theme.log; border.color: theme.warning; border.width: 2; radius: 4; z: 10
                ColumnLayout {
                    anchors { fill: parent; margins: 16 } spacing: 12
                    Label { text: "需要授权"; color: theme.warning; font.pixelSize: 18 }
                    ScrollView { Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                        TextArea { text: root.approvalText; readOnly: true; textFormat: TextEdit.PlainText; wrapMode: TextEdit.Wrap; color: theme.text; selectByMouse: true } }
                    RowLayout {
                        Button { text: "拒绝"; onClicked: root.send({type: "approval", requestId: root.approvalId, decision: "decline"}) }
                        Item { Layout.fillWidth: true }
                        Button { text: "允许一次"; onClicked: root.send({type: "approval", requestId: root.approvalId, decision: "accept"}) }
                    }
                }
            }
        }
    }
}
