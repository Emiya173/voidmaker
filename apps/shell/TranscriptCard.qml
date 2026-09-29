import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CutPanel {
    id: card
    property string value: ""
    property bool canSend: false
    property bool conflict: false
    property bool expanded: false
    property alias editor: entry.editor
    signal edited(string value)
    signal submitted()
    signal resolve(string action)
    signal escaped()
    color: "#244344"; borderColor: "#add6ca"
    implicitHeight: 50 + Math.max(40, entry.implicitHeight) + (expanded ? 42 : 0)
    function focusEditor() { entry.focusEditor() }
    ColumnLayout {
        id: body
        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 10 }
        spacing: 2
        RowLayout {
            Glyph { name: "mic"; ink: "#add6ca"; Layout.preferredWidth: 14; Layout.preferredHeight: 14 }
            Label { text: "待发送"; color: "#add6ca"; font.pixelSize: 11 }
            Item { Layout.fillWidth: true }
            IconButton { glyph: "close"; label: "放弃转写"; accent: "#add6ca"; implicitWidth: 28; implicitHeight: 28
                onClicked: card.resolve("discard") }
        }
        RowLayout {
            Layout.fillWidth: true
            TextEntry {
                id: entry
                Layout.fillWidth: true; Layout.preferredHeight: implicitHeight
                minimumHeight: 36; maximumHeight: 120
                placeholder: "编辑转写…"; value: card.value; ink: "#d8eeea"; selection: "#507f76"
                onEdited: value => card.edited(value)
                onSubmitted: { if (card.canSend) card.submitted() }
                onEscaped: card.escaped()
            }
            IconButton { glyph: "send"; label: "发送这段转写"; selected: true; accent: "#add6ca"
                enabled: card.canSend && card.value.trim().length > 0; onClicked: card.submitted() }
        }
        RowLayout {
            visible: card.expanded
            Label { visible: card.conflict; text: "文字草稿已保留"; color: "#d8eeea"; font.pixelSize: 11; Layout.fillWidth: true }
            Button { text: "替换"; flat: true; onClicked: card.resolve("replace") }
            Button { text: "追加"; flat: true; onClicked: card.resolve("append") }
        }
    }
}
