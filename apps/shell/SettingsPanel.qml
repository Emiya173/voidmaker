import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root
    property alias currentSection: sections.currentIndex
    property var snapshot: null
    property var diagnostics: null
    property bool online: false
    property bool canEdit: false
    property bool dirty: false
    property string formRevision: ""
    property bool reloadRequested: false
    property string notice: ""
    property var base: ({})
    signal command(var value)

    function load(config) {
        base = JSON.parse(JSON.stringify(config))
        inputTarget.text = config.inputTarget || ""
        outputTarget.text = config.aec ? config.aec.outputTarget : config.outputTarget || ""
        asrEnabled.checked = !!config.asr
        asrUrl.text = config.asr ? config.asr.url : "http://127.0.0.1:8000/v1/audio/transcriptions"
        asrModel.text = config.asr ? config.asr.model : "Qwen/Qwen3-ASR-0.6B"
        asrLanguage.text = config.asr ? config.asr.language || "" : ""
        asrHealth.text = config.asr ? config.asr.healthUrl || "" : ""
        asrTimeout.text = String(config.asr ? config.asr.timeoutMs : 60000)
        ttsEnabled.checked = !!config.tts
        ttsUrl.text = config.tts ? config.tts.url : "http://127.0.0.1:9880/tts"
        reference.text = config.tts ? config.tts.refAudioPath : ""
        promptText.text = config.tts ? config.tts.promptText : ""
        promptLanguage.text = config.tts ? config.tts.promptLanguage : "zh"
        textLanguage.text = config.tts ? config.tts.textLanguage : "auto"
        ttsHealth.text = config.tts ? config.tts.healthUrl || "" : ""
        ttsTimeout.text = String(config.tts ? config.tts.timeoutMs : 120000)
        silence.text = String(config.vad.silenceMs)
        threshold.text = String(config.vad.threshold)
        minSpeech.text = String(config.vad.minSpeechMs)
        maxRecording.text = String(config.vad.maxRecordingMs)
        aecEnabled.checked = !!config.aec
        bargeEnabled.checked = !!config.aec && config.aec.bargeIn
        plugin.text = config.aec ? config.aec.pluginDirectory : ""
        formRevision = snapshot ? snapshot.revision : ""
        dirty = false
    }
    function config() {
        const value = JSON.parse(JSON.stringify(base))
        delete value.inputTarget; delete value.outputTarget; delete value.asr; delete value.tts; delete value.aec
        if (inputTarget.text.trim()) value.inputTarget = inputTarget.text.trim()
        if (outputTarget.text.trim()) value.outputTarget = outputTarget.text.trim()
        value.vad = {threshold:Number(threshold.text), silenceMs:Number(silence.text), minSpeechMs:Number(minSpeech.text), maxRecordingMs:Number(maxRecording.text)}
        if (asrEnabled.checked) {
            value.asr = {url:asrUrl.text.trim(),model:asrModel.text.trim(),timeoutMs:Number(asrTimeout.text)}
            if (asrLanguage.text.trim()) value.asr.language = asrLanguage.text.trim()
            if (asrHealth.text.trim()) value.asr.healthUrl = asrHealth.text.trim()
        }
        if (ttsEnabled.checked) {
            value.tts = {url:ttsUrl.text.trim(),refAudioPath:reference.text.trim(),promptText:promptText.text.trim(),promptLanguage:promptLanguage.text.trim(),textLanguage:textLanguage.text.trim(),timeoutMs:Number(ttsTimeout.text)}
            if (base.tts && base.tts.provider) value.tts.provider = base.tts.provider
            if (base.tts && base.tts.model) value.tts.model = JSON.parse(JSON.stringify(base.tts.model))
            if (ttsHealth.text.trim()) value.tts.healthUrl = ttsHealth.text.trim()
        }
        if (aecEnabled.checked) value.aec = Object.assign({},base.aec || {},{pluginDirectory:plugin.text.trim(),outputTarget:outputTarget.text.trim(),bargeIn:bargeEnabled.checked})
        return value
    }
    function receive(event) {
        if (event.type === "settings") {
            const changed = !snapshot || snapshot.revision !== event.settings.revision
            snapshot = event.settings
            if (!snapshot.busy && (reloadRequested || (changed && !dirty))) { load(snapshot.config); reloadRequested = false; notice = "已加载当前生效配置" }
            else if (!snapshot.busy && changed && dirty) notice = "配置已在其他操作中更新，未保存草稿仍保留；请重新读取后再编辑。"
        } else if (event.type === "settings_applied" && snapshot) { load(snapshot.config); notice = "配置已保存并生效" }
        else if (event.type === "diagnostics") diagnostics = event.diagnostics
    }
    function stateLabel(state) {
        return ({ready:"就绪",reachable:"可连接",warming:"未就绪/预热中",unconfigured:"未配置",error:"异常"})[state] || state
    }
    component Field: ColumnLayout {
        id: field
        property string label: ""
        property alias text: edit.text
        signal edited()
        Layout.fillWidth: true; spacing: 2
        Label { text: field.label; color: "#bbc5d9"; wrapMode: Text.Wrap; Layout.fillWidth: true }
        TextField { id: edit; Layout.fillWidth: true; maximumLength: 4096; onTextEdited: field.edited() }
    }
    RowLayout {
        Button { text: "保存并应用"; enabled: root.canEdit && root.dirty && !!root.snapshot && !root.snapshot.busy
            onClicked: root.command({type:"settings_save",revision:root.formRevision,config:root.config()}) }
        Button { text: "重新读取"; enabled: root.canEdit && !!root.snapshot && !root.snapshot.busy
            onClicked: { root.reloadRequested = true; root.command({type:"settings_reload"}) } }
        Button { text: "恢复上一份"; enabled: root.canEdit && !!root.snapshot && !root.snapshot.busy && root.snapshot.canRestore
            onClicked: restoreDialog.open() }
    }
    Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#dccb9a"; textFormat: Text.PlainText
        text: root.snapshot && root.snapshot.error ? root.snapshot.error : root.dirty ? (root.formRevision !== root.snapshot.revision ? root.notice : "有未保存修改。保存前请停止对话和录音。") : root.notice }
    TabBar { id: sections; Layout.fillWidth: true; TabButton { text: "配置" } TabButton { text: "诊断" } }
    ScrollView {
        visible: sections.currentIndex === 0
        Layout.fillWidth: true; Layout.fillHeight: true; clip: true
        contentWidth: availableWidth
        ColumnLayout {
            width: parent.width; spacing: 10; enabled: root.canEdit && !!root.snapshot && !root.snapshot.busy
            Label { text: "设备"; color: "#eee"; font.bold: true }
            Field { id: inputTarget; label: "麦克风 node.name（留空使用默认；AEC 必须指定）"; onEdited: root.dirty = true }
            ComboBox { Layout.fillWidth: true; model: root.diagnostics ? root.diagnostics.devices.filter(d => d.kind === "input") : []
                textRole: "description"; valueRole: "name"; displayText: "选择诊断发现的麦克风"
                onActivated: { inputTarget.text = currentValue; root.dirty = true } }
            Field { id: outputTarget; label: "播放设备 node.name（AEC 参考也使用此输出）"; onEdited: root.dirty = true }
            ComboBox { Layout.fillWidth: true; model: root.diagnostics ? root.diagnostics.devices.filter(d => d.kind === "output") : []
                textRole: "description"; valueRole: "name"; displayText: "选择诊断发现的播放设备"
                onActivated: { outputTarget.text = currentValue; root.dirty = true } }
            CheckBox { id: asrEnabled; text: "启用 ASR"; palette.windowText: "#eee"; onToggled: root.dirty = true }
            ColumnLayout { visible: asrEnabled.checked; Layout.fillWidth: true
                Field { id: asrUrl; label: "ASR 请求地址（仅本机回环）"; onEdited: root.dirty = true }
                Field { id: asrModel; label: "模型名称"; onEdited: root.dirty = true }
                Field { id: asrLanguage; label: "语言（留空自动识别）"; onEdited: root.dirty = true }
                Field { id: asrTimeout; label: "识别超时 / ms（100–300000）"; onEdited: root.dirty = true }
                Field { id: asrHealth; label: "健康检查地址（留空使用同服务 /health）"; onEdited: root.dirty = true }
            }
            CheckBox { id: ttsEnabled; text: "启用 TTS"; palette.windowText: "#eee"; onToggled: root.dirty = true }
            ColumnLayout { visible: ttsEnabled.checked; Layout.fillWidth: true
                Field { id: ttsUrl; label: "TTS 请求地址（仅本机回环）"; onEdited: root.dirty = true }
                Field { id: reference; label: "全局参考音频绝对路径"; onEdited: root.dirty = true }
                Field { id: promptText; label: "参考音频的准确文本"; onEdited: root.dirty = true }
                Field { id: promptLanguage; label: "参考音频语言"; onEdited: root.dirty = true }
                Field { id: textLanguage; label: "输出语言"; onEdited: root.dirty = true }
                Field { id: ttsTimeout; label: "合成超时 / ms（100–300000）"; onEdited: root.dirty = true }
                Field { id: ttsHealth; label: "健康检查地址（留空仅检查 /openapi.json）"; onEdited: root.dirty = true }
                Label { Layout.fillWidth: true; text: "角色包中的声音配置会覆盖全局参考音频与语言。"; color: "#bbc5d9"; wrapMode: Text.Wrap }
            }
            Label { text: "语音端点检测"; color: "#eee"; font.bold: true }
            Field { id: threshold; label: "能量阈值（0.001–0.5）"; onEdited: root.dirty = true }
            Field { id: silence; label: "句末静音等待 / ms（200–3000）"; onEdited: root.dirty = true }
            Field { id: minSpeech; label: "最短语音 / ms（60–2000）"; onEdited: root.dirty = true }
            Field { id: maxRecording; label: "最长录音 / ms（1000–60000）"; onEdited: root.dirty = true }
            CheckBox { id: aecEnabled; text: "启用双路采集与 AEC 辅助"; palette.windowText: "#eee"; onToggled: root.dirty = true }
            ColumnLayout { visible: aecEnabled.checked; Layout.fillWidth: true
                Field { id: plugin; label: "AEC 插件根目录（绝对路径）"; onEdited: root.dirty = true }
                CheckBox { id: bargeEnabled; text: "连续对话允许插话"; palette.windowText: "#eee"; onToggled: root.dirty = true }
                Label { Layout.fillWidth: true; text: "已有 AEC 检测参数会保留。设备必须与实际外放及麦克风匹配。"; color: "#bbc5d9"; wrapMode: Text.Wrap }
            }
        }
    }
    ColumnLayout {
        visible: sections.currentIndex === 1
        Layout.fillWidth: true; Layout.fillHeight: true
        RowLayout {
            Button { text: "检查服务与设备"; enabled: root.online && !!root.snapshot && !root.snapshot.busy && (!root.diagnostics || root.diagnostics.phase !== "running")
                onClicked: root.command({type:"diagnostics_start"}) }
            Button { text: "取消检查"; enabled: root.online && !!root.diagnostics && root.diagnostics.phase === "running"
                onClicked: root.command({type:"diagnostics_cancel"}) }
        }
        Label { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#bbc5d9"
            text: "检查已保存配置，不录音、不合成、不发起 Codex 回复。设备存在不代表声音质量已验证。" }
        Label { Layout.fillWidth: true; color: "#dccb9a"; text: !root.diagnostics ? "尚未检查" : root.diagnostics.phase === "running" ? "检查中…"
            : root.diagnostics.phase === "cancelled" ? "检查已取消" : root.diagnostics.checkedAt ? "检查时间：" + root.diagnostics.checkedAt : "尚未检查" }
        ListView { Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 14
            model: root.diagnostics ? root.diagnostics.results : []
            delegate: Label { required property var modelData; width: ListView.view.width; wrapMode: Text.Wrap; textFormat: Text.PlainText
                text: modelData.label + " · " + root.stateLabel(modelData.status) + "\n" + modelData.detail
                color: modelData.status === "error" ? "#f5a5a5" : "#eee" }
        }
    }
    Dialog { id: restoreDialog; title: "恢复上一份配置"; modal: true; anchors.centerIn: parent; standardButtons: Dialog.Ok | Dialog.Cancel
        Label { text: "恢复后立即生效，当前配置会成为新的备份。" }
        onAccepted: { if(root.canEdit && root.snapshot) root.command({type:"settings_restore",revision:root.snapshot.revision}) }
    }
}
