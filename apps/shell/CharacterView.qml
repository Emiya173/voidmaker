import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: view
    required property var snapshot
    property bool online: true
    property bool windowVisible: true
    readonly property var presentation: snapshot ? snapshot.presentation : null
    property var avatar: null
    onPresentationChanged: {
        const next = presentation && presentation.avatar ? presentation.avatar : null
        // Playback projections arrive frequently; keep geometry delegates alive.
        if (JSON.stringify(avatar) !== JSON.stringify(next)) avatar = next
    }
    readonly property real mouth: online && presentation ? presentation.mouth : 0
    readonly property string stateLabel: !online ? "未连接" : !presentation ? "待命"
        : ({idle: "待命", listening: "正在聆听", thinking: "思考中", speaking: "说话中", error: "需要留意"})[presentation.state]
    readonly property string name: snapshot ? (snapshot.characters.find(c => c.id === snapshot.selectedId) || {}).name || "VoidMaker" : "VoidMaker"
    implicitWidth: 280
    implicitHeight: 490

    Item {
        id: portrait
        anchors { left: parent.left; right: parent.right; top: parent.top; bottom: caption.top; bottomMargin: 10 }
        Loader {
            id: avatarLoader
            anchors.fill: parent
            active: !!view.avatar
            // Load lazily so machines without Qt Quick 3D retain the portrait UI.
            source: active ? "Character3D.qml" : ""
            onLoaded: {
                item.avatar = Qt.binding(() => view.avatar || ({height: 20, centerY: 10, parts: []}))
                item.mouth = Qt.binding(() => view.mouth)
                item.online = Qt.binding(() => view.online)
                item.windowVisible = Qt.binding(() => view.windowVisible)
            }
        }
        Image {
            id: base
            visible: avatarLoader.status !== Loader.Ready
            anchors.fill: parent
            source: view.presentation ? view.presentation.baseUrl : ""
            fillMode: Image.PreserveAspectFit
            verticalAlignment: Image.AlignBottom
            sourceSize.width: 600
            cache: true
        }
        Image {
            id: frame
            visible: avatarLoader.status !== Loader.Ready
            anchors.fill: parent
            source: view.presentation ? view.presentation.imageUrl : ""
            fillMode: Image.PreserveAspectFit
            verticalAlignment: Image.AlignBottom
            sourceSize.width: 600
            cache: true
        }
        Rectangle {
            anchors.centerIn: parent
            width: 144; height: 158; radius: 48
            visible: avatarLoader.status !== Loader.Ready && base.status !== Image.Ready && frame.status !== Image.Ready
            color: "#25384a"
            border.color: view.presentation && view.presentation.state === "listening" ? "#97e5cc" : "#7397b5"
            border.width: 2
            Row {
                anchors.horizontalCenter: parent.horizontalCenter
                y: 50; spacing: 36
                Repeater { model: 2; Rectangle { width: 12; height: 16; radius: 6; color: "#d8f1ff" } }
            }
            Rectangle {
                anchors.horizontalCenter: parent.horizontalCenter
                y: 101; width: 30; height: 4 + 20 * view.mouth; radius: height / 2
                color: "#a4e9db"
            }
        }
    }
    Rectangle {
        id: caption
        anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
        height: labels.implicitHeight + 20
        radius: 14; color: "#e61b2433"
        ColumnLayout {
            id: labels
            anchors { left: parent.left; right: parent.right; top: parent.top; margins: 10 }
            spacing: 5
            Label { Layout.fillWidth: true; text: view.name + " · " + view.stateLabel
                color: "#c7eae5"; textFormat: Text.PlainText; elide: Text.ElideRight }
            Label {
                Layout.fillWidth: true
                visible: view.online && !!view.presentation && view.presentation.subtitle.length > 0
                text: visible ? view.presentation.subtitle : ""
                color: "#eef2f9"; textFormat: Text.PlainText
                wrapMode: Text.Wrap; maximumLineCount: 4; elide: Text.ElideRight
            }
        }
    }
}
