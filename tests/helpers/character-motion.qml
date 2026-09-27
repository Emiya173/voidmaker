import QtQuick
import QtQuick.Window
import Quickshell
import "APP_SHELL" as App

// No compositor window or GPU is needed for this lifecycle/transform check.
ShellRoot {
    id: probe
    property int step: 0
    property var neutral
    function check(value, description) {
        if (!value) { console.error("MOTION_PROBE_FAILED", description); Qt.quit(); throw new Error(description) }
    }
    Window {
        id: probeWindow
        visible: true; width: 280; height: 490
        App.Character3D {
            id: avatar
            width: 280; height: 490
            automaticMotion: false
            windowVisible: probeWindow.visible
            avatar: ({
                height:20, centerY:10, restEyes:0.3,
                expressions:["sleepy", "smile"], poses:["yawn", "think", "greet"],
                parts:[{meshUrl:"",textureUrl:"",color:[1,1,1,1],doubleSided:false}],
                idleRig:{version:1,pivots:[[0,0,0],[0,12,0],[0,16,0],[0,17,0],[0.5,18,1],[-0.5,18,1]]}
            })
        }
    }
    Timer {
        interval: 100; repeat: true; running: true
        onTriggered: {
            const state = avatar.motionSnapshot()
            if (probe.step === 0) {
                probe.neutral = state
                probe.check(state.weights.length === 8, "morph slots missing")
                avatar.motionSeconds = 2.4
            } else if (probe.step === 1) {
                probe.check(state.root === probe.neutral.root, "fixed root moved")
                probe.check(state.chest !== probe.neutral.chest && state.headRotation !== probe.neutral.headRotation, "joints did not move")
                avatar.online = false
            } else if (probe.step === 2) {
                probe.check(state.headRotation === probe.neutral.headRotation && state.chest === probe.neutral.chest, "offline did not reset joints")
                probe.check(state.weights.every((value, i) => Math.abs(value - (i === 2 ? 0.3 : 0)) < 0.000001), "offline facial state not neutral")
                avatar.online = true; avatar.automaticMotion = true
            } else if (probe.step === 3) {
                probe.check(state.seconds > 0, "online clock not running")
                avatar.visible = false
            } else if (probe.step === 4) {
                probe.check(state.seconds === 0 && state.headRotation === probe.neutral.headRotation, "hidden did not reset")
                avatar.visible = true
            } else if (probe.step === 5) {
                probe.check(state.seconds > 0, "unhide did not restart")
                avatar.avatar = Object.assign({}, avatar.avatar, {centerY:10.1})
                probe.check(avatar.elapsedSeconds === 0, "avatar switch did not restart clock")
                avatar.online = false
            } else if (probe.step === 6) {
                probe.check(state.seconds === 0 && state.blink === 0, "disconnect did not stop clock")
                avatar.online = true; avatar.automaticMotion = false; avatar.motionSeconds = 2.4
                avatar.sleepy = 1; avatar.smile = 1; avatar.mouth = 0.45
            } else if (probe.step === 7) {
                probe.check(state.weights[2] === 0 && state.weights[3] === 0.5 && state.weights[4] === 0.5, "expression blend over-applied rest eyelids")
                avatar.yawn = 1
            } else if (probe.step === 8) {
                probe.check(state.idleStrength === 0 && state.headRotation === probe.neutral.headRotation, "author pose did not suppress idle joints")
                probe.check(state.weights.every((value, i) => value === (i === 5 ? 1 : 0)), "author pose facial state double-applied")
                avatar.yawn = 0; avatar.sleepy = 0; avatar.smile = 0
            } else if (probe.step === 9) {
                probe.check(state.headRotation !== probe.neutral.headRotation && Math.abs(state.weights[2] - 0.3) < 0.000001, "pose exit did not restore normal controls")
                avatar.automaticMotion = true; probeWindow.visible = false
            } else if (probe.step === 10) {
                probe.check(state.seconds === 0 && state.headRotation === probe.neutral.headRotation, "hidden window did not stop animation")
                probeWindow.visible = true
            } else if (probe.step === 11) {
                probe.check(state.seconds > 0, "shown window did not restart animation")
                avatar.avatar = Object.assign({}, avatar.avatar, {expressions:[],poses:[]})
                avatar.yawn = 1; avatar.sleepy = 1; avatar.automaticMotion = false
            } else if (probe.step === 12) {
                probe.check(avatar.poseTotal === 0 && avatar.expressionTotal === 0, "unsupported controls affected legacy avatar")
                probe.check(state.weights.length === 3 && Math.abs(state.weights[2] - 0.3) < 0.000001, "legacy eyelids changed under unsupported expression")
                console.log("MOTION_PROBE_OK"); Qt.quit()
            }
            probe.step++
        }
    }
}
