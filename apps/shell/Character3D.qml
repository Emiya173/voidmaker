import QtQuick
import QtQuick3D
import "CharacterMotion.js" as Motion

View3D {
    id: scene
    property var avatar: ({height: 20, centerY: 10, parts: []})
    property real mouth: 0
    property bool online: true
    // Supplied by the containing panel/window; proxy windows are not ordinary
    // QQuickWindow parents, so Item.visible alone cannot report panel hiding.
    property bool windowVisible: true
    property string action: ""
    property int actionSerial: 0
    property bool automaticAction: true
    property real actionSeconds: 0
    property bool actionPaused: false
    readonly property bool skeletal: !!avatar.motionRig
    readonly property real actionTime: actionSkeleton.time
    readonly property real actionDuration: actionSkeleton.duration
    readonly property bool actionPlaying: actionSkeleton.playing
    readonly property bool actionReady: actionSkeleton.ready
    property real blink: 0
    property real sleepy: 0
    property real smile: 0
    property real yawn: 0
    property real think: 0
    property real greet: 0
    readonly property real yawnWeight: skeletal ? (actionSkeleton.actionName === "yawn" ? actionSkeleton.expressionWeight : 0) : (avatar.poses || []).indexOf("yawn") >= 0 ? Math.max(0, yawn) : 0
    readonly property real thinkWeight: skeletal ? (actionSkeleton.actionName === "think" ? actionSkeleton.expressionWeight : 0) : (avatar.poses || []).indexOf("think") >= 0 ? Math.max(0, think) : 0
    readonly property real greetWeight: skeletal ? (actionSkeleton.actionName === "greet" ? actionSkeleton.expressionWeight : 0) : (avatar.poses || []).indexOf("greet") >= 0 ? Math.max(0, greet) : 0
    readonly property real poseTotal: yawnWeight + thinkWeight + greetWeight
    readonly property real poseScale: motionActive ? 1 / Math.max(1, poseTotal) : 0
    readonly property real idleStrength: 1 - Math.min(1, poseTotal) * (motionActive ? 1 : 0)
    readonly property real sleepyWeight: (avatar.expressions || []).indexOf("sleepy") >= 0 ? Math.max(0, sleepy) : 0
    readonly property real smileWeight: (avatar.expressions || []).indexOf("smile") >= 0 ? Math.max(0, smile) : 0
    readonly property real expressionTotal: sleepyWeight + smileWeight
    readonly property real expressionScale: motionActive ? 1 / Math.max(1, expressionTotal) : 0
    // Developer inspection overrides; production defaults preserve normal behavior.
    property bool automaticMotion: true
    // Manual deterministic sample used by the inspector; zero is the bind pose.
    property real motionSeconds: 0
    property real elapsedSeconds: 0
    readonly property bool motionActive: scene.visible && scene.online && scene.windowVisible
    readonly property var movement: Motion.sample(motionActive ? (automaticMotion ? elapsedSeconds : motionSeconds) : 0)
    readonly property real effectiveBlink: motionActive ? (automaticMotion ? movement.blink : blink) : 0
    readonly property bool rigged: !!avatar.idleRig
    readonly property var pivots: rigged ? avatar.idleRig.pivots : [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]]
    function jointPosition(index, parentIndex) {
        const p = pivots[index], base = parentIndex < 0 ? [0, 0, 0] : pivots[parentIndex]
        return Qt.vector3d(p[0] - base[0], p[1] - base[1], p[2] - base[2])
    }
    function inverseBind(p) {
        return Qt.matrix4x4(1,0,0,-p[0], 0,1,0,-p[1], 0,0,1,-p[2], 0,0,0,1)
    }
    // Actual node transforms for headless lifecycle checks and inspection evidence.
    function motionSnapshot() {
        return {
            seconds: elapsedSeconds,
            windowVisible: windowVisible,
            root: rootJoint.scenePosition.toString(),
            chest: chestJoint.scenePosition.toString(),
            head: headJoint.scenePosition.toString(),
            eye: leftEyeJoint.scenePosition.toString(),
            headRotation: headJoint.eulerRotation.toString(),
            eyeRotation: leftEyeJoint.eulerRotation.toString(),
            blink: effectiveBlink,
            poseScale: poseScale,
            idleStrength: idleStrength,
            action: actionSkeleton.snapshot(),
            weights: parts.count ? parts.objectAt(0).faceTargets.map(target => target.weight) : []
        }
    }
    function resetMotion() {
        motionClock.stop()
        elapsedSeconds = 0
        if (motionActive && automaticMotion) motionClock.start()
    }
    onAvatarChanged: resetMotion()
    onMotionActiveChanged: resetMotion()
    onAutomaticMotionChanged: resetMotion()
    Component.onCompleted: resetMotion()
    property bool outlinesEnabled: true
    property int diagnosticMode: 0
    property real viewYaw: framing.yaw
    property real viewPitch: 0
    // Inspector camera offset, in fractions of the normalized character height.
    property real viewTargetX: 0
    readonly property var framing: avatar.framing || ({yaw: 0, zoom: 1, targetY: 0})
    readonly property real modelScale: 20 / avatar.height
    readonly property real yawRadians: viewYaw * Math.PI / 180
    readonly property real fitWidth: avatar.width
        ? (avatar.width * Math.abs(Math.cos(yawRadians)) + (avatar.depth || 0) * Math.abs(Math.sin(yawRadians))) * modelScale + 1.2
        : 20
    environment: SceneEnvironment {
        backgroundMode: SceneEnvironment.Transparent
        antialiasingMode: SceneEnvironment.MSAA
        antialiasingQuality: SceneEnvironment.High
        tonemapMode: SceneEnvironment.TonemapModeLinear
        debugSettings: DebugSettings {
            wireframeEnabled: scene.diagnosticMode === 3
            materialOverride: scene.diagnosticMode === 4 ? DebugSettings.Normals : DebugSettings.None
        }
    }
    camera: OrthographicCamera {
        x: scene.viewTargetX * 20
        z: 60
        y: scene.framing.targetY * 20
        clipNear: 0.1
        clipFar: 200
        horizontalMagnification: Math.max(1, Math.min(scene.height / 21.5, scene.width / scene.fitWidth)) * scene.framing.zoom
        verticalMagnification: horizontalMagnification
    }
    Node {
        // Normalize every model to 20 scene units, centered vertically.
        eulerRotation.y: scene.viewYaw
        eulerRotation.x: scene.viewPitch
        pivot: Qt.vector3d(0, scene.framing.targetY * 20, 0)
        y: scene.framing.targetY * 20
        Node {
            scale: Qt.vector3d(scene.modelScale, scene.modelScale, scene.modelScale)
            x: -(scene.avatar.centerX || 0) * scene.modelScale
            y: -scene.avatar.centerY * scene.modelScale
            CharacterSkeleton {
                id: actionSkeleton
                rig: scene.avatar.motionRig || null
                active: scene.motionActive
                action: scene.action
                actionSerial: scene.actionSerial
                automaticAction: scene.automaticAction
                actionSeconds: scene.actionSeconds
                actionPaused: scene.actionPaused
            }
            Node {
                id: rootJoint
                position: scene.jointPosition(0, -1)
                Node {
                    id: chestJoint
                    position: scene.jointPosition(1, 0).plus(Qt.vector3d(0, scene.movement.breath * scene.avatar.height * 0.0014 * scene.idleStrength, 0))
                    eulerRotation.x: scene.movement.chestPitch * scene.idleStrength
                    Node {
                        id: neckJoint
                        position: scene.jointPosition(2, 1)
                        eulerRotation.x: scene.movement.neckPitch * scene.idleStrength
                        Node {
                            id: headJoint
                            position: scene.jointPosition(3, 2)
                            eulerRotation: Qt.vector3d(scene.movement.headPitch, scene.movement.headYaw, scene.movement.headRoll).times(scene.idleStrength)
                            Node {
                                id: leftEyeJoint
                                position: scene.jointPosition(4, 3)
                                eulerRotation: Qt.vector3d(scene.movement.eyePitch, scene.movement.eyeYaw, 0).times(scene.idleStrength)
                            }
                            Node {
                                id: rightEyeJoint
                                position: scene.jointPosition(5, 3)
                                eulerRotation: Qt.vector3d(scene.movement.eyePitch, scene.movement.eyeYaw, 0).times(scene.idleStrength)
                            }
                        }
                    }
                }
            }
            Skin {
                id: idleSkin
                joints: [rootJoint, chestJoint, neckJoint, headJoint, leftEyeJoint, rightEyeJoint]
                inverseBindPoses: scene.pivots.map(p => scene.inverseBind(p))
            }
            Repeater3D {
                id: parts
                model: scene.avatar.parts
                delegate: Node {
                    id: part
                    required property var modelData
                    readonly property int faceAttributes: scene.avatar.poses && scene.avatar.poses.length
                        ? MorphTarget.Position | MorphTarget.Normal : MorphTarget.Position
                    readonly property var faceTargets: {
                        const targets = [mouthTarget, blinkTarget]
                        if (scene.avatar.restEyes !== undefined) targets.push(restEyesTarget)
                        for (const name of scene.avatar.expressions || [])
                            targets.push(name === "sleepy" ? sleepyTarget : smileTarget)
                        for (const name of scene.avatar.poses || [])
                            targets.push(name === "yawn" ? yawnTarget : name === "think" ? thinkTarget : greetTarget)
                        return targets
                    }
                    MorphTarget { id: mouthTarget; weight: scene.motionActive ? scene.mouth * scene.idleStrength : 0; attributes: part.faceAttributes }
                    MorphTarget { id: blinkTarget; weight: scene.effectiveBlink * scene.idleStrength; attributes: part.faceAttributes }
                    // Neutral eyelids are an authored appearance, retained offline.
                    // Fade them out during the blink so the two shapes never over-close.
                    MorphTarget {
                        id: restEyesTarget
                        weight: (scene.avatar.restEyes || 0) * (1 - blinkTarget.weight)
                            * (1 - Math.min(1, scene.expressionTotal) * (scene.motionActive ? 1 : 0))
                            * scene.idleStrength
                        attributes: part.faceAttributes
                    }
                    MorphTarget {
                        id: sleepyTarget
                        weight: scene.sleepyWeight * scene.expressionScale * (1 - blinkTarget.weight) * scene.idleStrength
                        attributes: part.faceAttributes
                    }
                    MorphTarget {
                        id: smileTarget
                        weight: scene.smileWeight * scene.expressionScale * (1 - blinkTarget.weight) * scene.idleStrength
                        attributes: part.faceAttributes
                    }
                    MorphTarget {
                        id: yawnTarget
                        weight: scene.yawnWeight * scene.poseScale
                        attributes: MorphTarget.Position | MorphTarget.Normal
                    }
                    MorphTarget {
                        id: thinkTarget
                        weight: scene.thinkWeight * scene.poseScale
                        attributes: MorphTarget.Position | MorphTarget.Normal
                    }
                    MorphTarget {
                        id: greetTarget
                        weight: scene.greetWeight * scene.poseScale
                        attributes: MorphTarget.Position | MorphTarget.Normal
                    }
                    Model {
                        source: modelData.meshUrl
                        materials: CharacterMaterial { part: part.modelData; diagnosticMode: scene.diagnosticMode }
                        morphTargets: part.faceTargets
                        skin: scene.skeletal ? actionSkeleton.skin : scene.rigged ? idleSkin : null
                    }
                    Model {
                        visible: scene.outlinesEnabled && scene.diagnosticMode === 0 && !!modelData.toon && modelData.toon.edgeSize > 0 && modelData.color[3] >= 1 && modelData.toon.edgeColor[3] > 0
                        source: modelData.meshUrl
                        materials: CustomMaterial {
                            property real uEdgeWidth: part.modelData.toon ? part.modelData.toon.edgeSize * 0.025 / scene.modelScale * (part.modelData.style ? part.modelData.style.outlineScale : 1) : 0
                            property vector4d uEdgeColor: {
                                const color = part.modelData.style && part.modelData.style.outlineColor
                                    ? part.modelData.style.outlineColor : part.modelData.toon ? part.modelData.toon.edgeColor : [0, 0, 0]
                                return Qt.vector4d(color[0], color[1], color[2], 1)
                            }
                            cullMode: Material.FrontFaceCulling
                            vertexShader: "shaders/character-outline.vert"
                            fragmentShader: "shaders/character-outline.frag"
                        }
                        morphTargets: part.faceTargets
                        skin: scene.skeletal ? actionSkeleton.skin : scene.rigged ? idleSkin : null
                    }
                }
            }
        }
    }
    NumberAnimation {
        id: motionClock
        target: scene; property: "elapsedSeconds"
        from: 0; to: 120; duration: 120000; loops: Animation.Infinite
    }
}
