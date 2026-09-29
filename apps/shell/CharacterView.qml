import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: view
    required property var snapshot
    property bool online: true
    property bool windowVisible: true
    property bool useModel: false
    readonly property bool modelAvailable: !!avatar
    readonly property bool modelReady: avatarLoader.status === Loader.Ready
    readonly property bool modelError: useModel && avatarLoader.status === Loader.Error
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
        anchors.fill: parent
        Loader {
            id: avatarLoader
            anchors.fill: parent
            active: !!view.avatar && view.useModel
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
            visible: !view.useModel || !view.avatar || view.modelError
            anchors.fill: parent
            source: view.presentation ? view.presentation.baseUrl : ""
            fillMode: Image.PreserveAspectFit
            verticalAlignment: Image.AlignBottom
            sourceSize.width: 600
            cache: true
            asynchronous: true
            retainWhileLoading: true
        }
        Image {
            id: frame
            visible: !view.useModel || !view.avatar || view.modelError
            anchors.fill: parent
            source: view.presentation ? view.presentation.imageUrl : ""
            fillMode: Image.PreserveAspectFit
            verticalAlignment: Image.AlignBottom
            sourceSize.width: 600
            cache: true
            asynchronous: true
            retainWhileLoading: true
        }
    }
}
