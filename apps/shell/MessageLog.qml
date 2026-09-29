import QtQuick
import QtQuick.Controls

ListView {
    id: log
    property string draft: ""
    property bool followTail: true
    clip: true; spacing: 12
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar {}
    function changed() { if (followTail) Qt.callLater(() => { if (followTail) positionViewAtEnd() }) }
    onMovementEnded: followTail = atYEnd
    onContentYChanged: { if (moving || dragging) followTail = atYEnd }
    onContentHeightChanged: changed()
    onHeightChanged: changed()
    onDraftChanged: changed()
    delegate: Item {
        id: row
        required property string role
        required property string content
        width: log.width; height: copy.implicitHeight + 28
        CutPanel {
            x: row.role === "user" ? 26 : 0; width: row.width - 26; height: row.height
            reverse: row.role === "user"
            color: row.role === "user" ? "#244344" : "#392d40"
            borderColor: row.role === "user" ? "#557c76" : "#806076"
            Rectangle { width: 3; height: parent.height - 22; y: row.role === "user" ? 0 : 11
                x: row.role === "user" ? parent.width - width : 0
                color: row.role === "user" ? "#add6ca" : "#dfabc1" }
            TextEdit {
                id: copy
                anchors { left: parent.left; right: parent.right; top: parent.top; margins: 14 }
                text: row.content; textFormat: TextEdit.PlainText; readOnly: true; selectByMouse: true
                wrapMode: TextEdit.Wrap; font.pixelSize: 15
                color: row.role === "user" ? "#d8eeea" : "#f4e0ed"
                selectionColor: "#806076"; selectedTextColor: "#ffffff"
            }
        }
    }
    footer: Item {
        width: log.width; height: log.draft ? streaming.implicitHeight + 40 : 0
        visible: !!log.draft
        CutPanel { width: parent.width - 26; height: parent.height - 12; y: 12; color: "#392d40"; borderColor: "#806076"
            Label { id: streaming; anchors { left: parent.left; right: parent.right; top: parent.top; margins: 14 }
                text: log.draft; textFormat: Text.PlainText; wrapMode: Text.Wrap; color: "#f4e0ed"; font.pixelSize: 15 }
        }
    }
    IconButton {
        anchors { bottom: parent.bottom; right: parent.right; margins: 8 }
        visible: !log.followTail; glyph: "down"; label: "回到最新消息"; selected: true
        onClicked: { log.followTail = true; log.positionViewAtEnd() }
    }
}
