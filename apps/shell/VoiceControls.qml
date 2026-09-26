import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: control
    required property var snapshot
    required property bool chatIdle
    signal command(var value)
    spacing: 6
    readonly property bool available: !!snapshot && snapshot.inputAvailable
    readonly property string phase: snapshot ? snapshot.phase : "idle"
    readonly property var labels: ({ idle: "待命", listening: "正在聆听", transcribing: "识别中", review: "转写待确认",
        preparing: "准备音频", interrupting: "正在停止播报", thinking: "生成回复", synthesizing: "合成中", speaking: "朗读中", stopping: "停止中" })

    RowLayout {
        Layout.fillWidth: true
        Button {
            text: control.phase === "listening" ? "结束说话" : "开始说话"
            enabled: control.available && control.chatIdle && ["idle", "review", "listening"].includes(control.phase)
            onClicked: control.command(control.phase === "listening" ? { type: "voice_finish" }
                : { type: "voice_start", continuous: continuous.checked })
        }
        CheckBox {
            id: continuous
            text: control.snapshot && control.snapshot.bargeInAvailable ? "连续对话（可打断）" : "连续对话"
            enabled: control.chatIdle && ["idle", "review"].includes(control.phase)
            ToolTip.visible: hovered
            ToolTip.text: control.snapshot && control.snapshot.bargeInAvailable
                ? "识别后自动发送；播报期间保持拾音，检测到插话会停止播报。停止键关闭麦克风。"
                : control.snapshot && control.snapshot.aecAvailable
                    ? "识别后自动发送；AEC 会话保持拾音，回复结束后开始下一轮识别。停止键关闭麦克风。"
                    : "识别后自动发送；回复播放结束后重新拾音。停止键退出。"
        }
        Label { text: control.available ? control.labels[control.phase] : "未配置 ASR"; color: "#9dddbf" }
    }
    Label {
        Layout.fillWidth: true
        visible: !!control.snapshot && control.snapshot.aecAvailable && control.snapshot.continuous
            && !["idle", "preparing", "stopping"].includes(control.phase)
        text: "连续对话期间麦克风保持开启，点击停止可关闭。"
        color: "#9dddbf"
        wrapMode: Text.Wrap
    }
    Label {
        Layout.fillWidth: true
        visible: control.phase === "review"
        text: "请在下方更正转写，然后发送。"
        color: "#a9b8d8"
    }
    Label {
        Layout.fillWidth: true
        visible: !!control.snapshot && control.snapshot.error.length > 0
        text: control.snapshot ? control.snapshot.error : ""
        color: "#f5a5a5"
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
    }
    Label {
        Layout.fillWidth: true
        visible: control.phase === "speaking" || control.phase === "synthesizing"
        text: control.snapshot ? control.snapshot.subtitle : ""
        color: "#c5d2ef"
        wrapMode: Text.Wrap
        maximumLineCount: 3
        elide: Text.ElideRight
        textFormat: Text.PlainText
    }
    ProgressBar {
        Layout.fillWidth: true
        visible: control.phase === "speaking" || control.phase === "listening"
        from: 0; to: 1
        value: !control.snapshot ? 0 : control.phase === "listening" ? Math.min(1, control.snapshot.level * 8)
            : control.snapshot.position / Math.max(0.01, control.snapshot.duration)
    }
}
