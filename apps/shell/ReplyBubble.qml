import QtQuick
import QtQuick.Controls

Item {
    id: bubble
    property string text: ""
    property bool tail: true
    implicitHeight: sentence.implicitHeight + 32
    Rectangle { x: 2; y: 4; width: plate.width; height: plate.height; radius: 9; color: "#28201828" }
    Rectangle {
        id: plate
        width: parent.width - (bubble.tail ? 8 : 0); height: parent.height
        color: "#ead7e0"; border.color: "#c19eaf"; radius: 9
        Rectangle { visible: bubble.tail; width: 12; height: 12; rotation: 45
            anchors { right: parent.right; rightMargin: -5; bottom: parent.bottom; bottomMargin: 16 }
            color: "#ead7e0"; border.color: "#c19eaf" }
        Rectangle { visible: bubble.tail; width: 8; height: 19; color: parent.color
            anchors { right: parent.right; rightMargin: 1; bottom: parent.bottom; bottomMargin: 12 } }
        Label {
            id: sentence
            anchors { left: parent.left; right: parent.right; top: parent.top; margins: 16 }
            text: bubble.text; textFormat: Text.PlainText
            color: "#382c3a"; font.pixelSize: 16; lineHeight: 1.25
            wrapMode: Text.Wrap; maximumLineCount: 5; elide: Text.ElideRight
        }
    }
}
