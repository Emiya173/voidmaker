import QtQuick
import QtQuick3D

CustomMaterial {
    id: material
    required property var part
    property int diagnosticMode: 0
    property int uDiagnosticMode: diagnosticMode
    readonly property var toon: part.toon || null
    readonly property var style: part.style || ({tint: [1, 1, 1], saturation: 1, contrast: 1, shadeStrength: 0, textureStrength: 0, specularStrength: 1})
    // Vector uniforms retain PMX's authored values; QColor would linearize them early.
    property vector4d uDiffuse: Qt.vector4d(part.color[0], part.color[1], part.color[2], part.color[3])
    property vector3d uAmbient: toon ? Qt.vector3d(...toon.ambient) : Qt.vector3d(0, 0, 0)
    property vector3d uSpecular: toon ? Qt.vector3d(...toon.specular) : Qt.vector3d(0, 0, 0)
    property real uShininess: toon ? toon.shininess : 50
    property bool uToon: !!toon
    property bool uHasMap: !!part.textureUrl
    property bool uHasRamp: !!toon && !!toon.rampUrl
    property bool uBlend: part.color[3] < 1
    property vector3d uTint: Qt.vector3d(...style.tint)
    property real uSaturation: style.saturation
    property real uContrast: style.contrast
    property real uShadeStrength: style.shadeStrength
    property real uTextureStrength: style.textureStrength
    property real uSpecularStrength: style.specularStrength
    property vector3d uLight: Qt.vector3d(-0.35, 0.65, 1.0)
    property TextureInput uMap: TextureInput {
        enabled: material.uHasMap
        texture: Texture {
            source: material.part.textureUrl
            generateMipmaps: true
            minFilter: Texture.Linear
            magFilter: Texture.Linear
            mipFilter: Texture.Linear
        }
    }
    property TextureInput uRamp: TextureInput {
        enabled: material.uHasRamp
        texture: Texture {
            source: material.toon ? material.toon.rampUrl : ""
            tilingModeHorizontal: Texture.ClampToEdge
            tilingModeVertical: Texture.ClampToEdge
            minFilter: Texture.Linear
            magFilter: Texture.Linear
        }
    }
    shadingMode: CustomMaterial.Shaded
    cullMode: part.doubleSided ? Material.NoCulling : Material.BackFaceCulling
    sourceBlend: uBlend ? CustomMaterial.SrcAlpha : CustomMaterial.NoBlend
    destinationBlend: uBlend ? CustomMaterial.OneMinusSrcAlpha : CustomMaterial.NoBlend
    sourceAlphaBlend: CustomMaterial.One
    destinationAlphaBlend: CustomMaterial.OneMinusSrcAlpha
    fragmentShader: "shaders/character-toon.frag"
}
