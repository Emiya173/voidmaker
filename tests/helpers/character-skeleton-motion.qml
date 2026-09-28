import QtQuick
import QtQuick.Window
import Quickshell
import "APP_SHELL" as App

ShellRoot {
    id: probe
    property string base: "CLIP_BASE"
    property string localClip: "LOCAL_CLIP"
    property int step: 0
    property int waitTicks: 0
    property real pausedTime: 0
    function check(value, label) {
        if (!value) { console.error("SKELETON_PROBE_FAILED", label, JSON.stringify(avatar.motionSnapshot())); Qt.quit(); throw new Error(label) }
    }
    function close(a,b) { return Math.abs(a-b) < 0.00001 }
    function neutral(state) { return close(state.nodePositions[2][0], -Math.SQRT2) && close(state.nodePositions[2][1], 1+Math.SQRT2) }
    function model(key) {
        const matrix = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
        return {height:20,centerY:10,restEyes:.3,expressions:["sleepy","smile"],poses:["yawn","think","greet"],
            parts:[{meshUrl:"",textureUrl:"",color:[1,1,1,1]}],
            motionRig:{version:1,assetKey:key,joints:[
                {name:"root",parent:-1,translation:[0,0,0],rotation:[1,0,0,0],inverseBind:matrix},
                {name:"arm",parent:0,translation:[0,1,0],rotation:[Math.cos(Math.PI/8),0,0,Math.sin(Math.PI/8)],inverseBind:matrix},
                {name:"hand",parent:1,translation:[0,2,0],rotation:[1,0,0,0],inverseBind:matrix}
            ],clips:[{name:"think",url:localClip,duration:.6},{name:"greet",url:base+"/slow",duration:.6},{name:"yawn",url:base+"/bad",duration:.6}]}}
    }
    Window {
        visible: true; width: 240; height: 320
        App.Character3D { id: avatar; width:240; height:320; automaticMotion:false; automaticAction:false; avatar:probe.model("one") }
    }
    Timer {
        interval: 80; repeat: true; running: true
        onTriggered: {
            const snapshot = avatar.motionSnapshot(), state = snapshot.action
            if (probe.step === 0) {
                probe.check(state.skinJoints === 3 && probe.neutral(state), "authored neutral actual Skin nodes")
                avatar.actionSeconds=.3; avatar.action="think"; avatar.yawn=1
            } else if (probe.step === 1) {
                if (!state.ready && probe.waitTicks++ < 20) return
                probe.check(state.ready && probe.close(state.nodePositions[2][0],-2) && probe.close(state.nodePositions[2][1],1), "manual FK reaches hand")
                probe.check(snapshot.weights[6] === 1 && snapshot.weights[5] === 0, "clip face only, legacy pose ignored")
                avatar.online=false
            } else if (probe.step === 2) {
                probe.check(!state.ready && probe.neutral(state) && state.faceWeight === 0, "offline cancels")
                avatar.online=true
            } else if (probe.step === 3) {
                probe.check(!state.ready && probe.neutral(state), "online does not replay consumed request")
                avatar.actionSerial++
            } else if (probe.step === 4) {
                probe.check(state.ready, "explicit same-name replay")
                avatar.windowVisible=false
            } else if (probe.step === 5) {
                probe.check(!state.ready && probe.neutral(state), "window hide cancels")
                avatar.windowVisible=true
            } else if (probe.step === 6) {
                probe.check(!state.ready, "show does not replay")
                avatar.actionSeconds=0; avatar.automaticAction=true; avatar.actionSerial++
            } else if (probe.step === 7) {
                probe.check(state.playing && state.time > 0, "automatic time advances")
                avatar.actionPaused=true; probe.pausedTime=avatar.actionTime
            } else if (probe.step === 8) {
                probe.check(probe.close(state.time,probe.pausedTime) && !state.playing, "pause holds time")
                avatar.actionPaused=false
            } else if (probe.step === 9) {
                if (state.time < .6) return
                probe.check(!state.playing && probe.neutral(state) && state.faceWeight===0, "completion restores neutral")
                avatar.automaticAction=false; avatar.action="greet"
            } else if (probe.step === 10) {
                avatar.online=false; probe.waitTicks=0
            } else if (probe.step === 11) {
                if (++probe.waitTicks < 6) return
                probe.check(!state.ready && probe.neutral(state), "late cancelled response ignored")
                avatar.online=true; avatar.actionSerial++
            } else if (probe.step === 12) {
                avatar.avatar=probe.model("replacement"); probe.waitTicks=0
            } else if (probe.step === 13) {
                if (++probe.waitTicks < 6) return
                probe.check(!state.ready && probe.neutral(state), "late replaced-asset response ignored")
                avatar.action="yawn"; probe.waitTicks=0
            } else if (probe.step === 14) {
                if (!state.error && probe.waitTicks++ < 20) return
                probe.check(!state.ready && !!state.error && probe.neutral(state), "bad clip falls back to neutral")
                avatar.action=""
            } else {
                probe.check(!state.ready && state.name==="" && probe.neutral(state), "stop restores neutral")
                console.log("SKELETON_PROBE_OK"); Qt.quit()
            }
            probe.step++
        }
    }
    Timer { interval:12000; running:true; onTriggered:{ probe.check(false,"timeout"); Qt.quit() } }
}
