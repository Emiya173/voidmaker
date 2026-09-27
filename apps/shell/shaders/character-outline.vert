void MAIN()
{
    // UV1.x carries PMX edgeRatio; the same morphed mesh is used for both passes.
    VERTEX += NORMAL * uEdgeWidth * UV1.x;
}
