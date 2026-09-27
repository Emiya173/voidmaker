void MAIN()
{
    // A zero-width hull coincides with the surface and causes speckled depth fighting.
    if (UV1.x < 0.02 || uEdgeWidth <= 0.0) discard;
    BASE_COLOR = vec4(pow(uEdgeColor.rgb, vec3(2.2)), 1.0);
    ROUGHNESS = 1.0;
}
void AMBIENT_LIGHT() { DIFFUSE += pow(uEdgeColor.rgb, vec3(2.2)); }
void DIRECTIONAL_LIGHT() {}
void POINT_LIGHT() {}
void SPOT_LIGHT() {}
void SPECULAR_LIGHT() {}
