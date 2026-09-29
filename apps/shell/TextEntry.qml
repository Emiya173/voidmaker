import QtQuick
import QtQuick.Controls

Flickable {
    id: entry
    property string value: ""
    property string placeholder: "说点什么…"
    property color ink: "#f0e3ed"
    property color selection: "#655367"
    property int minimumHeight: 52
    property int maximumHeight: 120
    property alias editor: editor
    signal edited(string value)
    signal submitted()
    signal escaped()
    clip: true
    implicitHeight: Math.min(maximumHeight, Math.max(minimumHeight, editor.implicitHeight))
    contentWidth: width
    contentHeight: editor.height
    boundsBehavior: Flickable.StopAtBounds
    flickableDirection: Flickable.VerticalFlick
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
    onValueChanged: { if (editor.text !== value) editor.text = value }
    function focusEditor() { editor.forceActiveFocus(Qt.OtherFocusReason) }
    TextArea {
        id: editor
        width: entry.width - 10
        height: Math.max(entry.minimumHeight, implicitHeight)
        text: entry.value
        color: entry.ink; selectionColor: entry.selection; selectedTextColor: "#ffffff"
        placeholderText: entry.placeholder; placeholderTextColor: "#aa96ad"
        Accessible.name: entry.placeholder
        textFormat: TextEdit.PlainText; wrapMode: TextEdit.Wrap
        font.pixelSize: 15; padding: 8
        selectByMouse: true; persistentSelection: true
        background: null
        onCursorRectangleChanged: {
            if (!activeFocus) return
            const top = cursorRectangle.y
            const bottom = top + cursorRectangle.height + 8
            if (top < entry.contentY) entry.contentY = top
            else if (bottom > entry.contentY + entry.height) entry.contentY = bottom - entry.height
        }
        onTextChanged: {
            if (text.length > 10000) { remove(10000, length); return }
            if (text !== entry.value) entry.edited(text)
        }
        Keys.onPressed: event => {
            if (event.key === Qt.Key_Escape && !inputMethodComposing) {
                focus = false; entry.escaped(); event.accepted = true
            } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier)) {
                if (!inputMethodComposing && !event.isAutoRepeat) entry.submitted()
                // IME sees composition events before Keys; never turn confirmation into submission.
                event.accepted = !inputMethodComposing
            }
        }
    }
}
