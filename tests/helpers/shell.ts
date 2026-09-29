/** Offscreen Qt has no layer-shell. Keep production views, replace only the window integration. */
export function offscreenShell(source: string): string {
  return source
    .replaceAll(
      "PanelWindow {",
      "FloatingWindow {\n        minimumSize: Qt.size(implicitWidth, implicitHeight)\n        maximumSize: minimumSize",
    )
    .replace(/^\s*anchors \{ (left|right): true; bottom: true \}\s*$/gm, "")
    .replace(/^\s*(margins \{|exclusionMode:|focusable:|WlrLayershell\.keyboardFocus:).*/gm, "")
    .replace(/ {8}mask: Region \{[\s\S]*?\n {8}}\n/g, "");
}
