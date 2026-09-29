import QtQuick
import QtQuick.Shapes

Item {
    id: panel
    property color color: "#202d30"
    property color borderColor: "#655367"
    property real cut: 12
    property bool reverse: false
    Shape {
        anchors.fill: parent
        ShapePath {
            strokeWidth: 1; strokeColor: panel.borderColor; fillColor: panel.color
            startX: 0.5; startY: 0.5
            PathLine { x: panel.width - (panel.reverse ? 0.5 : panel.cut); y: 0.5 }
            PathLine { x: panel.width - 0.5; y: panel.reverse ? 0.5 : panel.cut }
            PathLine { x: panel.width - 0.5; y: panel.height - 0.5 }
            PathLine { x: panel.reverse ? panel.cut : 0.5; y: panel.height - 0.5 }
            PathLine { x: 0.5; y: panel.height - (panel.reverse ? panel.cut : 0.5) }
            PathLine { x: 0.5; y: 0.5 }
        }
    }
}
