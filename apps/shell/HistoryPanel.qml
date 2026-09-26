import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root
    property alias currentSection: sections.currentIndex
    property string sessionId: ""
    property string characterId: ""
    property bool canEdit: false
    property bool online: false
    property var sessions: []
    property var history: []
    property var memories: []
    property string sessionNext: ""
    property string historyNext: ""
    property string historySession: ""
    property string historyTitle: "当前会话"
    property int serial: 0
    property string sessionRequest: ""
    property string historyRequest: ""
    property string memoryRequest: ""
    property bool appendSessions: false
    property bool appendHistory: false
    property var editingMemory: null
    property var pendingAction: null
    signal command(var value)

    function listSessions(more = false) {
        if (!online || !sessionId) return
        appendSessions = more
        sessionRequest = "sessions-" + (++serial)
        const value = {type: "session_list", requestId: sessionRequest,
            query: sessionSearch.text, archived: archived.checked}
        if (more && sessionNext) value.before = sessionNext
        command(value)
    }
    function listHistory(more = false) {
        if (!online || !historySession) return
        appendHistory = more
        historyRequest = "history-" + (++serial)
        const value = {type: "history_list", requestId: historyRequest,
            sessionId: historySession, query: historySearch.text}
        if (more && historyNext) value.before = historyNext
        command(value)
    }
    function listMemories() {
        if (!online || !sessionId) return
        memoryRequest = "memory-" + (++serial)
        command({type: "memory_list", requestId: memoryRequest, sessionId})
    }
    function resetMemory() {
        editingMemory = null
        memoryText.text = ""
        memoryScope.currentIndex = 0
        memoryEnabled.checked = true
    }
    function receive(event) {
        if (event.type === "snapshot") {
            const changed = sessionId !== event.sessionId
            sessionId = event.sessionId
            characterId = event.character.selectedId
            if (changed) {
                sessions = []; history = []; memories = []
                sessionNext = ""; historyNext = ""
                historySession = sessionId; historyTitle = "当前会话"
                sessionSearch.text = ""; historySearch.text = ""
                archived.checked = false
                resetMemory()
            }
            listSessions(); listHistory(); listMemories()
        } else if (event.type === "library_changed") {
            historySession = sessionId; historyTitle = "当前会话"
            listSessions(); listHistory(); listMemories(); resetMemory()
        } else if (event.type === "session_list" && event.requestId === sessionRequest && event.characterId === characterId) {
            sessions = appendSessions ? sessions.concat(event.page.items) : event.page.items
            sessionNext = event.page.next || ""
        } else if (event.type === "history_list" && event.requestId === historyRequest && event.sessionId === historySession) {
            history = appendHistory ? history.concat(event.page.items) : event.page.items
            historyNext = event.page.next || ""
        } else if (event.type === "memory_list" && event.requestId === memoryRequest && event.sessionId === sessionId) {
            memories = event.items
        }
    }
    TabBar {
        id: sections; Layout.fillWidth: true
        TabButton { text: "会话" }
        TabButton { text: "历史" }
        TabButton { text: "记忆" }
    }
    ColumnLayout {
        visible: sections.currentIndex === 0
        Layout.fillWidth: true; Layout.fillHeight: true
        RowLayout {
            TextField { id: newTitle; Layout.fillWidth: true; placeholderText: "新会话标题"; maximumLength: 120 }
            Button { text: "新建"; enabled: root.canEdit && !!newTitle.text.trim()
                onClicked: root.command({type: "session_create", title: newTitle.text.trim()}) }
        }
        RowLayout {
            TextField { id: sessionSearch; Layout.fillWidth: true; placeholderText: "搜索会话标题"; maximumLength: 200
                onAccepted: root.listSessions() }
            CheckBox { id: archived; palette.windowText: "#eee"; text: "已归档"; onToggled: root.listSessions() }
            Button { text: "查找"; enabled: root.online; onClicked: root.listSessions() }
        }
        ListView {
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 8
            model: root.sessions
            delegate: ColumnLayout {
                required property var modelData
                width: ListView.view.width
                Label { Layout.fillWidth: true; text: (modelData.id === root.sessionId ? "● " : "") + modelData.title
                    color: "#eee"; textFormat: Text.PlainText; elide: Text.ElideRight }
                RowLayout {
                    Button { text: "切换"; enabled: root.canEdit && !modelData.archived && modelData.id !== root.sessionId
                        onClicked: root.command({type: "session_select", id: modelData.id}) }
                    Button { text: "历史"; enabled: root.online
                        onClicked: { root.historySession = modelData.id; root.historyTitle = modelData.title; historySearch.text = ""; root.listHistory(); sections.currentIndex = 1 } }
                    Button { text: "改名"; enabled: root.canEdit
                        onClicked: { root.pendingAction = modelData; renameTitle.text = modelData.title; renameDialog.open() } }
                    Button { text: modelData.archived ? "恢复" : "归档"; enabled: root.canEdit && modelData.id !== root.sessionId
                        onClicked: root.command({type: "session_archive", id: modelData.id, revision: modelData.revision, archived: !modelData.archived}) }
                    Button { text: "删除"; visible: modelData.archived; enabled: root.canEdit
                        onClicked: { root.pendingAction = {type: "session_delete", id: modelData.id, revision: modelData.revision}; deleteDialog.open() } }
                }
            }
        }
        Button { text: "更多会话"; visible: !!root.sessionNext; enabled: root.online; onClicked: root.listSessions(true) }
        Label { Layout.fillWidth: true; text: "归档当前会话前请先切换；删除仅用于已归档会话。"
            wrapMode: Text.Wrap; color: "#abb4c7" }
    }
    ColumnLayout {
        visible: sections.currentIndex === 1
        Layout.fillWidth: true; Layout.fillHeight: true
        Label { Layout.fillWidth: true; text: root.historyTitle + " · 最新在前"; color: "#eee"; textFormat: Text.PlainText; elide: Text.ElideRight }
        RowLayout {
            TextField { id: historySearch; Layout.fillWidth: true; placeholderText: "搜索消息内容"; maximumLength: 200; onAccepted: root.listHistory() }
            Button { text: "查找"; enabled: root.online; onClicked: root.listHistory() }
            Button { text: "当前会话"; enabled: root.online; onClicked: { root.historySession = root.sessionId; root.historyTitle = "当前会话"; root.listHistory() } }
        }
        ListView {
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 12
            model: root.history
            delegate: Label {
                required property var modelData
                width: ListView.view.width
                text: (modelData.role === "user" ? "我" : "助手") + " · " + modelData.createdAt + "\n" + modelData.text
                textFormat: Text.PlainText; color: "#eee"; wrapMode: Text.Wrap
            }
        }
        Button { text: "更早消息"; visible: !!root.historyNext; enabled: root.online; onClicked: root.listHistory(true) }
    }
    ColumnLayout {
        visible: sections.currentIndex === 2
        Layout.fillWidth: true; Layout.fillHeight: true
        Label { Layout.fillWidth: true; text: "手动记忆会发送给 Codex。更改后，下次对话启用新上下文；历史仍可查阅，但不重放给模型。"
            wrapMode: Text.Wrap; color: "#dccb9a" }
        ListView {
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 10
            model: root.memories
            delegate: ColumnLayout {
                required property var modelData
                width: ListView.view.width
                Label { Layout.fillWidth: true; text: (modelData.sessionId ? "本会话" : "本角色") + (modelData.enabled ? " · 已启用" : " · 已停用") + "\n" + modelData.text
                    wrapMode: Text.Wrap; color: "#eee"; textFormat: Text.PlainText }
                RowLayout {
                    Button { text: "编辑"; enabled: root.canEdit; onClicked: {
                        root.editingMemory = modelData; memoryText.text = modelData.text
                        memoryScope.currentIndex = modelData.sessionId ? 1 : 0; memoryEnabled.checked = modelData.enabled
                    } }
                    Button { text: modelData.enabled ? "停用" : "启用"; enabled: root.canEdit
                        onClicked: root.command({type: "memory_save", sessionId: root.sessionId, id: modelData.id, revision: modelData.revision,
                            scope: modelData.sessionId ? "session" : "character", text: modelData.text, enabled: !modelData.enabled}) }
                    Button { text: "删除"; enabled: root.canEdit; onClicked: {
                        root.pendingAction = {type: "memory_delete", sessionId: root.sessionId, id: modelData.id, revision: modelData.revision}; deleteDialog.open()
                    } }
                }
            }
        }
        RowLayout {
            ComboBox { id: memoryScope; model: ["本角色所有会话", "仅当前会话"]; enabled: root.canEdit && !root.editingMemory }
            CheckBox { id: memoryEnabled; palette.windowText: "#eee"; text: "启用"; checked: true; enabled: root.canEdit }
            Button { text: "刷新"; enabled: root.online; onClicked: root.listMemories() }
            Button { text: "新记忆"; enabled: root.canEdit; onClicked: root.resetMemory() }
        }
        ScrollView {
            Layout.fillWidth: true; Layout.preferredHeight: 100
            TextArea { id: memoryText; placeholderText: "手动填写事实或偏好（最多 2000 字）"; textFormat: TextEdit.PlainText; wrapMode: TextEdit.Wrap; enabled: root.canEdit }
        }
        Button { text: root.editingMemory ? "保存修改" : "保存记忆"; enabled: root.canEdit && memoryText.text.trim().length > 0 && memoryText.text.length <= 2000
            onClicked: {
                const value = {type: "memory_save", sessionId: root.sessionId, scope: memoryScope.currentIndex === 1 ? "session" : "character",
                    text: memoryText.text.trim(), enabled: memoryEnabled.checked}
                if (root.editingMemory) { value.id = root.editingMemory.id; value.revision = root.editingMemory.revision }
                root.command(value)
            } }
    }
    Dialog {
        id: renameDialog; title: "重命名会话"; modal: true; anchors.centerIn: parent
        standardButtons: Dialog.Ok | Dialog.Cancel
        TextField { id: renameTitle; maximumLength: 120 }
        onAccepted: { if (root.canEdit && renameTitle.text.trim()) root.command({type: "session_rename", id: root.pendingAction.id, revision: root.pendingAction.revision, title: renameTitle.text.trim()}) }
    }
    Dialog {
        id: deleteDialog; title: "确认删除"; modal: true; anchors.centerIn: parent
        standardButtons: Dialog.Ok | Dialog.Cancel
        Label { text: "删除后无法在应用中恢复。确认继续？" }
        onAccepted: { if (root.canEdit) root.command(root.pendingAction) }
    }
}
