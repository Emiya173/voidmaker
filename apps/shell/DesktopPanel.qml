import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ScrollView {
    id: panel
    property var snapshot: null
    property bool online: false
    property bool canSend: false
    signal command(var value)
    signal attach(string id)
    clip: true
    contentWidth: availableWidth
    function configure(enabled) {
        command({type: "desktop_policy", policy: {
            proactive: enabled, intervalSeconds: interval.value,
            startHour: startHour.value, endHour: endHour.value,
            excludedApps: excluded.text.split("\n").map(v => v.trim()).filter(v => v.length > 0)
        }})
    }
    onSnapshotChanged: {
        if (!snapshot) return
        interval.value = snapshot.policy.intervalSeconds
        startHour.value = snapshot.policy.startHour
        endHour.value = snapshot.policy.endHour
        excluded.text = snapshot.policy.excludedApps.join("\n")
    }
    ColumnLayout {
        width: panel.availableWidth
        spacing: 10
        Label { text: "桌面上下文"; color: "#f1f2f7"; font.pixelSize: 18; font.bold: true }
        Label {
            Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#bbc5dc"
            text: "授权后可读取并预览。常驻开关会保存；截图仍由你手动框选。"
        }
        Repeater {
            model: [{source: "window", name: "窗口（当前 / 最近聚焦）"}, {source: "media", name: "媒体信息"}, {source: "region", name: "框选截图"}]
            delegate: ColumnLayout {
                required property var modelData
                readonly property double expiry: panel.snapshot ? panel.snapshot.grants[modelData.source] : 0
                readonly property bool granted: expiry === -1 || expiry > Date.now()
                Layout.fillWidth: true
                Label { color: "#f1f2f7"; text: modelData.name; Layout.fillWidth: true; wrapMode: Text.Wrap }
                ToggleSwitch { objectName: "persistentGrant-" + modelData.source
                    text: "常驻授权"; checked: !!panel.snapshot && panel.snapshot.grants[modelData.source] === -1
                    enabled: panel.online && !!panel.snapshot && !panel.snapshot.busy
                    onClicked: panel.command(checked ? {type: "desktop_grant", source: modelData.source, persistent: true} : {type: "desktop_revoke", source: modelData.source}) }
                RowLayout {
                    Button { text: "授权 15 分钟"; enabled: panel.online && (!panel.snapshot || !panel.snapshot.busy)
                        onClicked: panel.command({type: "desktop_grant", source: modelData.source, minutes: 15}) }
                    Button { text: modelData.source === "region" ? "框选预览" : "读取预览"; enabled: panel.online && granted && !panel.snapshot.busy
                        onClicked: panel.command({type: "desktop_read", source: modelData.source}) }
                    Button { text: "撤销"; enabled: panel.online && granted
                        onClicked: panel.command({type: "desktop_revoke", source: modelData.source}) }
                }
            }
        }
        RowLayout {
            Button { text: "撤销全部授权"; enabled: panel.online; onClicked: panel.command({type: "desktop_revoke"}) }
            Button { text: "清除预览 / 取消读取"; enabled: panel.online; onClicked: panel.command({type: "desktop_clear"}) }
        }
        Repeater {
            model: panel.snapshot ? panel.snapshot.observations : []
            delegate: ColumnLayout {
                required property var modelData
                Layout.fillWidth: true
                Label { Layout.fillWidth: true; color: "#9dddbf"; text: modelData.provider + " · " + new Date(modelData.capturedAt).toLocaleTimeString(); wrapMode: Text.Wrap }
                Label { Layout.fillWidth: true; color: "#f1f2f7"; text: modelData.text; textFormat: Text.PlainText; wrapMode: Text.Wrap }
                Image { Layout.fillWidth: true; Layout.preferredHeight: visible ? 180 : 0; visible: !!modelData.imageUrl; source: modelData.imageUrl || ""; fillMode: Image.PreserveAspectFit; cache: false }
                TextField { id: question; Layout.fillWidth: true; placeholderText: "针对这份上下文提问"; maximumLength: 10000 }
                Button { text: "附加到文字草稿"; enabled: panel.online; onClicked: panel.attach(modelData.id) }
                Button { text: "发送"; enabled: panel.canSend && question.text.trim().length > 0
                    onClicked: { panel.command({type: "desktop_send", id: modelData.id, text: question.text.trim()}); question.clear() } }
            }
        }
        Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: "#343b50" }
        ToggleSwitch { objectName: "proactiveSwitch"
            text: "主动观察"; checked: !!panel.snapshot && panel.snapshot.policy.proactive; enabled: panel.online && !!panel.snapshot && !panel.snapshot.busy
            onClicked: panel.configure(checked) }
        Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#bbc5dc"
            text: "定期分析已授权的窗口与媒体，开关重启后保留。锁屏、空闲或对话时暂停，不自动截图。" }
        RowLayout {
            Label { text: "间隔（秒）"; color: "#f1f2f7" }
            SpinBox { id: interval; from: 60; to: 3600; value: 300; stepSize: 60; editable: true }
        }
        RowLayout {
            Label { text: "本地时段"; color: "#f1f2f7" }
            SpinBox { id: startHour; from: 0; to: 23; value: 9; editable: true }
            Label { text: "至"; color: "#f1f2f7" }
            SpinBox { id: endHour; from: 0; to: 23; value: 22; editable: true }
        }
        Label { text: "排除窗口 app_id（每行一个，精确匹配）"; color: "#bbc5dc" }
        TextArea { id: excluded; Layout.fillWidth: true; textFormat: TextEdit.PlainText; wrapMode: TextEdit.Wrap; placeholderText: "org.keepassxc.KeePassXC" }
        RowLayout {
            Button { text: "保存时段与排除项"; enabled: panel.online
                onClicked: panel.configure(!!panel.snapshot && panel.snapshot.policy.proactive) }
        }
        Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#bbc5dc"; text: panel.snapshot ? panel.snapshot.pauseReason : "等待连接" }
        Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#f5a5a5"; text: panel.snapshot ? panel.snapshot.error : ""; textFormat: Text.PlainText; visible: text.length > 0 }
        Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#9dddbf"; text: panel.snapshot ? panel.snapshot.suggestion : ""; textFormat: Text.PlainText; visible: text.length > 0 }
    }
}
