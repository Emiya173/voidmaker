import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ScrollView {
    id: panel
    property var snapshot: null
    property bool online: false
    property bool canSend: false
    signal command(var value)
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
            text: "授权后可读取并预览；点击发送才会附带给 Codex。截图每次手动框选，不读取剪贴板。撤销会停止相关回复，但无法撤回已经发送的数据。"
        }
        Repeater {
            model: [{source: "window", name: "窗口（当前 / 最近聚焦）"}, {source: "media", name: "媒体信息"}, {source: "region", name: "框选截图"}]
            delegate: ColumnLayout {
                required property var modelData
                readonly property double expiry: panel.snapshot ? panel.snapshot.grants[modelData.source] : 0
                Layout.fillWidth: true
                Label { color: "#f1f2f7"; text: modelData.name + (expiry > 0 ? " · 授权至 " + new Date(expiry).toLocaleTimeString() : " · 未授权") }
                RowLayout {
                    Button { text: "授权 15 分钟"; enabled: panel.online && (!panel.snapshot || !panel.snapshot.busy)
                        onClicked: panel.command({type: "desktop_grant", source: modelData.source, minutes: 15}) }
                    Button { text: modelData.source === "region" ? "框选并预览" : "读取并预览"; enabled: panel.online && expiry > 0 && !panel.snapshot.busy
                        onClicked: panel.command({type: "desktop_read", source: modelData.source}) }
                    Button { text: "撤销"; enabled: panel.online && expiry > 0
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
                Button { text: "确认发送给 Codex"; enabled: panel.canSend && question.text.trim().length > 0
                    onClicked: { panel.command({type: "desktop_send", id: modelData.id, text: question.text.trim()}); question.clear() } }
            }
        }
        Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: "#343b50" }
        Label { text: "主动观察（默认关闭）"; color: "#f1f2f7"; font.pixelSize: 18 }
        Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#bbc5dc"
            text: "开启后，已授权的窗口 / 媒体文本会定期发送给 Codex。只显示建议，不执行任务、不自动截图或播报。界面离线、空闲、会话锁定或对话中暂停。重启后需重新开启及授权。" }
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
            Button { text: panel.snapshot && panel.snapshot.policy.proactive ? "保存观察设置" : "确认开启主动观察"; enabled: panel.online
                onClicked: panel.configure(true) }
            Button { text: "关闭"; enabled: panel.online && !!panel.snapshot && panel.snapshot.policy.proactive; onClicked: panel.configure(false) }
        }
        Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#bbc5dc"; text: panel.snapshot ? panel.snapshot.pauseReason : "等待连接" }
        Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#f5a5a5"; text: panel.snapshot ? panel.snapshot.error : ""; textFormat: Text.PlainText; visible: text.length > 0 }
        Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#9dddbf"; text: panel.snapshot ? panel.snapshot.suggestion : ""; textFormat: Text.PlainText; visible: text.length > 0 }
    }
}
