// Qt's shaded pipeline applies morph targets and the final linear-to-sRGB transfer.
// Perform MMD's authored color/ramp operations in sRGB, then linearize once.
SHARED_VARS { vec3 color; };
float grainHash(vec2 cell)
{
    return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
}
float surfaceGrain(vec2 uv)
{
    vec2 cell = floor(uv);
    vec2 f = fract(uv);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(grainHash(cell), grainHash(cell + vec2(1.0, 0.0)), f.x),
               mix(grainHash(cell + vec2(0.0, 1.0)), grainHash(cell + vec2(1.0)), f.x), f.y);
}
void MAIN()
{
    vec4 texel = uHasMap ? texture(uMap, UV0) : vec4(1.0);
    float alpha = texel.a * uDiffuse.a;
    if (alpha < 0.1) discard;
    vec3 color = texel.rgb * uDiffuse.rgb;
    if (uToon) {
        vec3 normal = normalize(NORMAL + vec3(0.0, 0.0, 0.000001));
        vec3 light = normalize(uLight);
        float shade = clamp(dot(normal, light) * 0.5 + 0.5, 0.0, 1.0);
        vec3 ramp = uHasRamp
            // Qt texture V runs from bottom to top; the authored light band is at the top.
            ? texture(uRamp, vec2(0.5, shade)).rgb
            : mix(vec3(0.76, 0.74, 0.78), vec3(1.0), smoothstep(0.42, 0.58, shade));
        color = texel.rgb * min(uDiffuse.rgb * 0.6 + uAmbient, vec3(1.0)) * ramp;
        // Low-frequency form shading complements the authored hard toon bands.
        // Per-material strength keeps faces gentle and gives cloth/hair more depth.
        float form = smoothstep(-0.15, 0.95, dot(normal, light));
        color *= 1.0 - uShadeStrength * (1.0 - form);
        vec3 halfVector = normalize(light + VIEW_VECTOR);
        color += uSpecular * uSpecularStrength * 0.6 * pow(max(dot(normal, halfVector), 0.0), max(uShininess, 1.0));
    }
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, uSaturation);
    color = ((color - 0.5) * uContrast + 0.5) * uTint;
    if (uTextureStrength > 0.0 && uHasMap) {
        // UV-anchored matte texture, faded below pixel resolution to avoid shimmer.
        vec2 detailUv = UV0 * 500.0;
        float footprint = max(length(dFdx(detailUv)), length(dFdy(detailUv)));
        float fade = 1.0 - smoothstep(0.5, 1.4, footprint);
        color *= 1.0 + (surfaceGrain(detailUv) - 0.5) * uTextureStrength * fade;
    }
    if (uDiagnosticMode == 1) color = uHasMap ? texel.rgb : uDiffuse.rgb;
    if (uDiagnosticMode >= 2) color = vec3(0.72) * (0.45 + 0.55 * max(dot(normalize(NORMAL + vec3(0.000001)), normalize(uLight)), 0.0));
    BASE_COLOR = vec4(pow(clamp(color, 0.0, 1.0), vec3(2.2)), uBlend ? alpha : 1.0);
    SHARED.color = BASE_COLOR.rgb;
    ROUGHNESS = 1.0;
    METALNESS = 0.0;
}

void AMBIENT_LIGHT() { DIFFUSE += SHARED.color; }
void DIRECTIONAL_LIGHT() {}
void POINT_LIGHT() {}
void SPOT_LIGHT() {}
void SPECULAR_LIGHT() {}
