// Qt's shaded pipeline applies morph targets and the final linear-to-sRGB transfer.
// Perform MMD's authored color/ramp operations in sRGB, then linearize once.
SHARED_VARS { vec3 color; };
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
        vec3 halfVector = normalize(light + VIEW_VECTOR);
        color += uSpecular * 0.6 * pow(max(dot(normal, halfVector), 0.0), max(uShininess, 1.0));
    }
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
