import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: panel
    property bool online: false
    property var projects: []
    property var works: []
    property var detail: null
    property string selectedId: ""
    property int loadedRevision: -1
    property string preview: ""
    signal command(var value)
    readonly property var work: detail ? detail.work : null
    readonly property var latest: detail && detail.attempts.length ? detail.attempts[detail.attempts.length - 1] : null
    readonly property var names: ({draft: "草稿", queued: "排队", running: "执行中", awaiting_permission: "等待审批",
        cancelling: "取消中", completed: "完成", failed: "失败", cancelled: "已取消", interrupted: "已中断"})

    function select(id) {
        selectedId = id; detail = null; loadedRevision = -1; preview = ""
        command({type: "work_get", id: id})
    }
    function receive(event) {
        if (event.type === "work_list") { projects = event.projects; works = event.works }
        if (event.type === "work_saved") { select(event.id); draftInput.text = "" }
        if (event.type === "work_changed") {
            command({type: "work_list"})
            if (selectedId && (!event.id || event.id === selectedId)) command({type: "work_get", id: selectedId})
        }
        if (event.type === "work_detail" && event.detail.work.id === selectedId) {
            if (detail && detail.work.revision > event.detail.work.revision) return
            detail = event.detail
            if (loadedRevision !== detail.work.revision) {
                editInput.text = detail.work.prompt
                loadedRevision = detail.work.revision
            }
        }
        if (event.type === "artifact_preview") preview = event.path + "\nSHA-256: " + event.sha256 + "\n\n" + event.text
    }
    function useTranscript(text) { draftInput.text = text }
    function uuid() { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const n = Math.floor(Math.random() * 16); return (c === "x" ? n : (n & 3) | 8).toString(16)
    }) }
    spacing: 8
    RowLayout {
        Layout.fillWidth: true
        ComboBox { id: projectBox; Layout.fillWidth: true; model: panel.projects; textRole: "name"; valueRole: "id" }
        Button { text: projectForm.visible ? "收起" : "添加项目"; onClicked: projectForm.visible = !projectForm.visible }
    }
    ColumnLayout {
        id: projectForm
        visible: panel.projects.length === 0
        Layout.fillWidth: true
        TextField { id: projectName; Layout.fillWidth: true; placeholderText: "项目名称" }
        RowLayout {
            TextField { id: projectPath; Layout.fillWidth: true; placeholderText: "项目绝对路径" }
            Button { text: "保存"; enabled: panel.online && projectName.text.trim() && projectPath.text.trim()
                onClicked: { panel.command({type: "project_add", name: projectName.text.trim(), path: projectPath.text.trim()}); projectForm.visible = false } }
        }
    }
    ScrollView {
        Layout.fillWidth: true; Layout.preferredHeight: 76; clip: true
        TextArea { id: draftInput; placeholderText: "描述后台任务，或从对话页转入语音转写"; textFormat: TextEdit.PlainText; wrapMode: TextEdit.Wrap }
    }
    RowLayout {
        Button { text: "保存任务草稿"; enabled: panel.online && projectBox.currentIndex >= 0 && draftInput.text.trim().length > 0
            onClicked: panel.command({type: "work_draft", id: panel.uuid(), projectId: projectBox.currentValue, prompt: draftInput.text.trim()}) }
        Text { text: "确认草稿后执行"; color: "#adb8d0" }
    }
    ListView {
        id: taskList
        Layout.fillWidth: true; Layout.preferredHeight: 100
        clip: true; spacing: 3; model: panel.works
        delegate: ItemDelegate {
            required property var modelData
            width: taskList.width; height: 34
            text: (panel.names[modelData.status] || modelData.status) + " · " + modelData.prompt.replace(/\n/g, " ").slice(0, 60)
            highlighted: modelData.id === panel.selectedId
            onClicked: panel.select(modelData.id)
        }
    }
    ScrollView {
        Layout.fillWidth: true; Layout.fillHeight: true; clip: true
        contentWidth: availableWidth
        ColumnLayout {
            width: parent.width
            spacing: 8
            Text { Layout.fillWidth: true; text: panel.work ? (panel.names[panel.work.status] + " · 执行次数 " + panel.detail.attempts.length) : "选择任务查看详情"; color: "#a9dfc6" }
            Text { Layout.fillWidth: true; visible: !!panel.work
                text: panel.work ? ((panel.projects.find(p => p.id === panel.work.projectId) || {}).path || "") : ""
                textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere; color: "#adb8d0" }
            TextArea {
                id: editInput
                Layout.fillWidth: true
                visible: !!panel.work
                readOnly: !panel.work || panel.work.status !== "draft"
                textFormat: TextEdit.PlainText; wrapMode: TextEdit.Wrap
                color: "#f1f2f7"; background: Rectangle { color: "#272e3f"; radius: 8 }
            }
            Flow {
                Layout.fillWidth: true; spacing: 6
                Button { text: "保存修改"; visible: !!panel.work && panel.work.status === "draft"
                    enabled: panel.online && editInput.text.trim().length > 0
                    onClicked: panel.command({type: "work_edit", id: panel.work.id, revision: panel.work.revision, prompt: editInput.text.trim()}) }
                Button { text: "确认并执行"; visible: !!panel.work && panel.work.status === "draft"
                    enabled: panel.online && editInput.text.trim() === panel.work.prompt
                    onClicked: panel.command({type: "work_submit", id: panel.work.id, revision: panel.work.revision}) }
                Button { text: "重试（新执行）"; visible: !!panel.work && ["failed", "cancelled", "interrupted"].includes(panel.work.status)
                    enabled: panel.online
                    onClicked: panel.command({type: "work_retry", id: panel.work.id, revision: panel.work.revision}) }
                Button { text: "取消任务"; visible: !!panel.work && ["draft", "queued", "running", "awaiting_permission"].includes(panel.work.status)
                    enabled: panel.online; onClicked: panel.command({type: "work_cancel", id: panel.work.id}) }
            }
            Text { Layout.fillWidth: true; visible: !!panel.work && ["cancelled", "cancelling", "interrupted", "failed"].includes(panel.work.status)
                text: "已发生的修改会保留，重试前请检查项目文件。"; color: "#e2bd97"; wrapMode: Text.Wrap }
            Repeater {
                model: panel.detail ? panel.detail.approvals.filter(a => a.decision === null) : []
                delegate: ColumnLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    Text { text: "需要审批 · " + modelData.expiresAt; color: "#ffcdaa" }
                    TextArea { Layout.fillWidth: true; text: modelData.description; textFormat: TextEdit.PlainText; readOnly: true
                        wrapMode: TextEdit.WrapAnywhere; color: "#f1d8c8"; background: null }
                    RowLayout {
                        Button { text: "拒绝"; enabled: panel.online; onClicked: panel.command({type: "work_approval", id: modelData.id, decision: "decline"}) }
                        Button { text: "允许一次"; enabled: panel.online; onClicked: panel.command({type: "work_approval", id: modelData.id, decision: "accept"}) }
                    }
                }
            }
            TextArea { Layout.fillWidth: true; visible: !!panel.latest && !!(panel.latest.result || panel.latest.error)
                text: panel.latest ? (panel.latest.error || panel.latest.result) : ""; textFormat: TextEdit.PlainText
                readOnly: true; wrapMode: TextEdit.Wrap; color: "#f1f2f7"; background: null }
            Repeater {
                model: panel.detail ? panel.detail.artifacts : []
                delegate: Button {
                    required property var modelData
                    Layout.fillWidth: true
                    text: "查看 " + modelData.path + " · 第 " + (panel.detail.attempts.findIndex(a => a.id === modelData.attemptId) + 1) + " 次执行"
                    enabled: panel.online
                    onClicked: panel.command({type: "artifact_open", id: modelData.id})
                }
            }
            TextArea { Layout.fillWidth: true; visible: panel.preview.length > 0; text: panel.preview; textFormat: TextEdit.PlainText
                readOnly: true; wrapMode: TextEdit.WrapAnywhere; color: "#d6e5ff"; background: Rectangle { color: "#202838" } }
            Text { text: "执行记录（最近 100 条）"; visible: !!panel.detail; color: "#adb8d0" }
            CheckBox { id: approvalHistory; text: "显示审批历史"; palette.windowText: "#c2cbdf"; visible: !!panel.detail && panel.detail.approvals.length > 0 }
            TextArea {
                Layout.fillWidth: true; visible: approvalHistory.checked && !!panel.detail
                text: panel.detail ? panel.detail.approvals.filter(a => a.decision !== null).map(a =>
                    ({accept: "已允许一次", decline: "已拒绝", expired: "已过期"})[a.decision] + "\n" + a.description).join("\n\n") : ""
                textFormat: TextEdit.PlainText; readOnly: true; wrapMode: TextEdit.WrapAnywhere; color: "#c2cbdf"; background: null
            }
            TextArea {
                Layout.fillWidth: true; visible: !!panel.detail
                text: panel.detail ? panel.detail.events.map(e => e.createdAt + " · " + e.kind + "\n" + e.text).join("\n\n") : ""
                textFormat: TextEdit.PlainText; readOnly: true; wrapMode: TextEdit.WrapAnywhere
                color: "#c2cbdf"; background: null
            }
            TextArea {
                Layout.fillWidth: true; visible: !!panel.detail && panel.detail.attempts.length > 1
                text: panel.detail ? "历史执行\n" + panel.detail.attempts.map(a => a.id + " · " + (panel.names[a.status] || a.status) + "\n" + a.result + a.error).join("\n\n") : ""
                textFormat: TextEdit.PlainText; readOnly: true; wrapMode: TextEdit.WrapAnywhere; color: "#a5b2cb"; background: null
            }
        }
    }
}
