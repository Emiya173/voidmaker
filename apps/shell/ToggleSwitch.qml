import QtQuick
import QtQuick.Templates as T

T.Switch {
    id: control
    implicitWidth: implicitContentWidth + leftPadding + rightPadding
    implicitHeight: Math.max(40, implicitContentHeight + topPadding + bottomPadding)
    padding: 4
    spacing: 10
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    opacity: enabled ? 1 : 0.45
    Accessible.name: text

    Theme { id: theme }
    indicator: Rectangle {
        implicitWidth: 46; implicitHeight: 26
        x: control.mirrored ? control.width - width - control.rightPadding : control.leftPadding
        y: (control.height - height) / 2
        radius: 4
        // Activation belongs to Host state, not the window's active palette group.
        color: control.checked ? theme.mint : theme.input
        border.color: control.checked ? theme.mint : control.hovered ? theme.muted : theme.line
        Rectangle {
            objectName: "switchThumb"
            width: 18; height: 18; radius: 2
            x: 4 + control.visualPosition * (parent.width - width - 8)
            y: (parent.height - height) / 2
            color: control.checked ? theme.input : theme.muted
            Behavior on x {
                enabled: !control.down
                NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
            }
        }
    }
    contentItem: Text {
        text: control.text
        font: control.font
        color: theme.text
        verticalAlignment: Text.AlignVCenter
        leftPadding: control.mirrored ? 0 : control.indicator.width + control.spacing
        rightPadding: control.mirrored ? control.indicator.width + control.spacing : 0
    }
    background: Rectangle {
        radius: 5
        color: "transparent"
        border.width: control.visualFocus ? 1 : 0
        border.color: theme.pink
    }
}
