import QtQuick
import QtQuick3D
import Quickshell.Io
import "SkeletonMotion.js" as Motion

Node {
    id: skeleton
    property var rig: null
    property bool active: true
    property string action: ""
    property int actionSerial: 0
    property bool automaticAction: true
    property real actionSeconds: 0
    property bool actionPaused: false
    readonly property string assetKey: rig ? rig.assetKey : ""
    readonly property real time: clipData ? Math.max(0, Math.min(duration, automaticAction ? elapsed : actionSeconds)) : 0
    readonly property real duration: clipData ? clipData.duration : 0
    readonly property bool ready: !!clipData && jointNodes.length === (rig ? rig.joints.length : 0)
    readonly property bool playing: ready && active && automaticAction && clock.running && !clock.paused
    readonly property var pose: Motion.sample(rig ? rig.joints : [], active ? clipData : null, time)
    readonly property real expressionWeight: pose.expression
    property alias skin: jointSkin
    property string actionName: ""
    property string error: ""
    property real elapsed: 0
    property var clipData: null
    property var cache: ({})
    property var request: null
    property var fileRequest: null
    property int generation: 0
    property string consumedRequest: "\u0000"
    property bool initialized: false
    property var jointNodes: []

    function requestKey() { return action + ":" + actionSerial }
    function cancel() {
        generation++
        clock.stop()
        loadTimeout.stop()
        if (request) { request.onreadystatechange = null; request.abort(); request = null }
        if (fileRequest) { fileRequest.destroy(); fileRequest = null }
        clipData = null; actionName = ""; elapsed = 0
    }
    function playFrom(seconds) {
        clock.stop()
        elapsed = Math.max(0, Math.min(duration, seconds))
        if (!active || !automaticAction || !clipData || elapsed >= duration) return
        clock.from = elapsed; clock.to = duration
        clock.duration = Math.max(1, Math.round((duration - elapsed) * 1000))
        clock.start(); clock.paused = actionPaused
    }
    function accept(data, name) {
        clipData = data; actionName = name; error = ""
        if (automaticAction) playFrom(0)
    }
    function consumeText(text, descriptor, token, key) {
        if (token !== generation || key !== assetKey || !active) return
        loadTimeout.stop()
        try {
            if (text.length > 8 * 1024 * 1024) throw new Error("Action data too large")
            const data = JSON.parse(text)
            if (!Motion.validClip(data, rig.joints.length, descriptor.duration)) throw new Error("Invalid action data")
            cache[descriptor.url] = data
            accept(data, descriptor.name)
        } catch (failure) { error = String(failure); clipData = null }
    }
    function handleRequest() {
        if (!initialized || consumedRequest === requestKey()) return
        consumedRequest = requestKey()
        cancel(); error = ""
        if (!active || !rig || !action) return
        const descriptor = rig.clips.find(clip => clip.name === action)
        if (!descriptor) { error = "Unknown action"; return }
        if (cache[descriptor.url]) { accept(cache[descriptor.url], descriptor.name); return }
        const token = generation, key = assetKey
        // FileView reads local assets asynchronously without a process-wide XHR
        // permission. A fresh reader per request keeps late file signals tied
        // to their generation, just like HTTP fixture requests below.
        if (descriptor.url.startsWith("file:")) {
            try {
                // FileView takes a filesystem path. Its file:// shorthand does
                // not URI-decode escaped spaces or UTF-8 names.
                if (!descriptor.url.startsWith("file:///")) throw new Error("Invalid local action URL")
                const path = decodeURIComponent(descriptor.url.slice(7))
                fileRequest = localReader.createObject(skeleton, {token:token, asset:key, descriptor:descriptor})
                loadTimeout.start()
                fileRequest.path = path
            } catch (failure) { cancel(); error = String(failure) }
            return
        }
        const xhr = new XMLHttpRequest()
        request = xhr
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE || token !== generation || key !== assetKey || !active) return
            request = null; loadTimeout.stop(); xhr.onreadystatechange = null
            if (xhr.status !== 0 && xhr.status !== 200) { error = "Unreadable action"; return }
            consumeText(xhr.responseText, descriptor, token, key)
        }
        try { xhr.open("GET", descriptor.url); xhr.send(); loadTimeout.start() }
        catch (failure) { cancel(); error = String(failure) }
    }
    function syncJoints() {
        const nodes = []
        for (let i = 0; i < jointRepeater.count; i++) {
            const node = jointRepeater.objectAt(i)
            if (!node) { jointNodes = []; return }
            nodes.push(node)
        }
        jointNodes = nodes
    }
    function matrix(values) {
        return Qt.matrix4x4(values[0],values[1],values[2],values[3], values[4],values[5],values[6],values[7],
            values[8],values[9],values[10],values[11], values[12],values[13],values[14],values[15])
    }
    function snapshot() {
        return {name:actionName, time:time, duration:duration, ready:ready, playing:playing,
            paused:actionPaused, faceWeight:expressionWeight, error:error, joints:pose.joints,
            nodePositions:jointNodes.map(node => [node.x,node.y,node.z]), skinJoints:jointSkin.joints.length}
    }
    onActionChanged: Qt.callLater(handleRequest)
    onActionSerialChanged: Qt.callLater(handleRequest)
    onActiveChanged: {
        if (!active) { consumedRequest = requestKey(); cancel() }
    }
    onAssetKeyChanged: {
        cache = ({})
        if (initialized) { consumedRequest = requestKey(); cancel() }
    }
    onAutomaticActionChanged: {
        if (automaticAction) playFrom(actionSeconds)
        else clock.stop()
    }
    onActionPausedChanged: { if (clock.running) clock.paused = actionPaused }
    Component.onCompleted: { initialized = true; Qt.callLater(handleRequest) }
    Component.onDestruction: cancel()

    Component {
        id: localReader
        FileView {
            id: reader
            property int token: 0
            property string asset: ""
            property var descriptor
            preload: true
            blockLoading: false
            watchChanges: false
            printErrors: false
            onLoaded: {
                skeleton.consumeText(text(), descriptor, token, asset)
                if (skeleton.fileRequest === reader) skeleton.fileRequest = null
                destroy()
            }
            onLoadFailed: function(reason) {
                if (token === skeleton.generation && asset === skeleton.assetKey && skeleton.active) {
                    skeleton.localLoadFailed(reason)
                }
                if (skeleton.fileRequest === reader) skeleton.fileRequest = null
                destroy()
            }
        }
    }
    function localLoadFailed(reason) { loadTimeout.stop(); error = "Unreadable local action (" + reason + ")" }
    Repeater3D {
        id: jointRepeater
        model: skeleton.rig ? skeleton.rig.joints : []
        onObjectAdded: Qt.callLater(skeleton.syncJoints)
        onObjectRemoved: { skeleton.jointNodes = []; Qt.callLater(skeleton.syncJoints) }
        delegate: Node {
            required property int index
            readonly property var transform: skeleton.pose.joints[index]
            position: transform ? Qt.vector3d(transform.translation[0], transform.translation[1], transform.translation[2]) : Qt.vector3d(0,0,0)
            rotation: transform ? Qt.quaternion(transform.rotation[0], transform.rotation[1], transform.rotation[2], transform.rotation[3]) : Qt.quaternion(1,0,0,0)
        }
    }
    Skin {
        id: jointSkin
        joints: skeleton.jointNodes
        inverseBindPoses: skeleton.rig ? skeleton.rig.joints.map(joint => skeleton.matrix(joint.inverseBind)) : []
    }
    NumberAnimation { id: clock; target: skeleton; property: "elapsed" }
    Timer {
        id: loadTimeout; interval: 10000
        onTriggered: { skeleton.cancel(); skeleton.error = "Action load timed out" }
    }
}
