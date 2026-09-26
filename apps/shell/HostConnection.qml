import QtQuick
import Quickshell.Io

QtObject {
    id: root
    required property string path
    property var transport: null
    readonly property bool connected: !!transport && transport.connected
    signal message(string line)

    function send(command) {
        if (!connected) return
        transport.write(JSON.stringify(command) + "\n")
        transport.flush()
    }
    function discard() {
        const previous = transport
        transport = null
        if (previous) previous.destroy()
    }
    function connect() {
        discard()
        transport = socketComponent.createObject(root, {path: root.path})
        transport.connected = true
    }
    property Component socketComponent: Component {
        Socket {
            id: socket
            parser: SplitParser { onRead: line => { if (root.transport === socket) root.message(line) } }
            onError: {
                if (root.transport !== socket) return
                root.discard()
                retry.restart()
            }
            onConnectedChanged: {
                if (root.transport === socket && !connected) retry.restart()
            }
        }
    }
    property Timer retry: Timer { interval: 2000; onTriggered: root.connect() }
    Component.onCompleted: connect()
}
