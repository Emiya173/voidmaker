import QtQuick
import QtQuick.Controls

AbstractButton {
    id: control
    property string glyph: "chat"
    property string label: ""
    property bool selected: false
    property color accent: "#dfabc1"
    implicitWidth: 40; implicitHeight: 40
    hoverEnabled: true
    Accessible.name: label
    ToolTip.text: label
    ToolTip.visible: hovered || activeFocus
    ToolTip.delay: 300
    contentItem: Item {
        Glyph { anchors.centerIn: parent; name: control.glyph
            ink: control.selected ? "#231f2b" : control.accent; opacity: control.enabled ? 1 : 0.35 }
    }
    background: Rectangle {
        radius: 3
        color: control.selected ? control.accent : control.down ? "#655367" : control.hovered ? "#392d40" : "transparent"
        border.width: control.activeFocus ? 1 : 0
        border.color: control.accent
        Behavior on color { ColorAnimation { duration: 120 } }
    }
}
