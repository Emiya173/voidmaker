void MAIN()
{
    // A custom vertex snippet replaces Qt's automatic morph position step.
    // Apply the authored targets before extrusion; Skin is applied afterwards by
    // the shaded pipeline, using the same joints as the surface material.
    vec3 basePosition = VERTEX;
    vec3 baseNormal = NORMAL;
    for (int i = 0; i < QT_MORPH_MAX_COUNT; ++i) {
        VERTEX += MORPH_WEIGHTS[i] * (MORPH_POSITION(i) - basePosition);
#ifdef QT_TARGET_NORMAL_OFFSET
        NORMAL += MORPH_WEIGHTS[i] * (MORPH_NORMAL(i) - baseNormal);
#endif
    }
    if (length(NORMAL) > 0.00001) NORMAL = normalize(NORMAL);
    // UV1.x carries PMX edgeRatio.
    VERTEX += NORMAL * uEdgeWidth * UV1.x;
}
