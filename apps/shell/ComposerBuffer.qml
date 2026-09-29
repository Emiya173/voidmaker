import QtQuick

// Optimistic editor buffers only. Host owns drafts, generations and submit/merge rules.
QtObject {
    id: buffer
    property string sessionId: ""
    property string text: ""
    property string transcript: ""
    property int generation: -1
    property string desktopId: ""
    property string pendingText: ""
    property string pendingTranscript: ""
    property int serial: 0
    readonly property string clientId: Date.now().toString(36) + Math.random().toString(36).slice(2)
    signal command(var value)

    function receive(session, value, requestId, reconnect) {
        const changed = sessionId !== session
        const firstDraft = changed && !sessionId && !!pendingText
        if (changed) { sessionId = session; if (!firstDraft) pendingText = ""; pendingTranscript = "" }
        if (!pendingText || requestId === pendingText) { text = value.text; pendingText = "" }
        desktopId = value.desktopId || ""
        const next = value.transcript ? value.transcript.generation : -1
        if (next !== generation || !pendingTranscript || requestId === pendingTranscript) {
            generation = next; transcript = value.transcript ? value.transcript.text : ""; pendingTranscript = ""
        }
        if (reconnect && (!changed || firstDraft)) {
            if (pendingText) edit("text", text)
            if (pendingTranscript && generation >= 0) edit("transcript", transcript)
        }
    }
    function edit(source, value) {
        const requestId = clientId + "-" + (++serial)
        if (source === "text") { text = value; pendingText = requestId }
        else { transcript = value; pendingTranscript = requestId }
        if (sessionId) command({type: "composer_edit", sessionId, source, text: value, generation: Math.max(0, generation), requestId})
    }
    function send(source) {
        command({type: "composer_send", sessionId, source, generation: Math.max(0, generation)})
    }
    function resolve(action) { command({type: "composer_resolve", sessionId, generation, action}) }
    function attach(id) { command({type: "composer_attach", sessionId, id}) }
}
