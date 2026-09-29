import type { PixelIcon } from "../../contracts/src/tray-icon.js";

// Generic controller fallback. Character-specific pixel data lives in local packs.
// StatusNotifier requires network-order ARGB, independent of the desktop icon theme.
const badge = [
  "................",
  ".....pp..pp.....",
  "....pppppppp....",
  ".....pppppp.....",
  "......pppp......",
  ".......pp.......",
  "................",
  "...mmmmmmmmmm...",
  "..mddddddddddm..",
  ".mdddmdddddpddm.",
  ".mddmmmdddpdpdm.",
  ".mdddmdddddpddm.",
  ".mddddddmdddddm.",
  "..mmmmmm.mmmmm..",
  "...mmm....mmm...",
  "................",
];
const palette: Record<string, number> = { ".": 0, m: 0xffaccabe, d: 0xff24353b, p: 0xffe8acc6 };
export function trayPixmaps(icon?: PixelIcon): [number, number, Buffer][] {
  const rows = icon?.rows ?? badge;
  const colors = icon
    ? Object.fromEntries(
        Object.entries(icon.palette).map(([key, hex]) => [key, Number.parseInt(`ff${hex.slice(1)}`, 16)]),
      )
    : palette;
  colors["."] = 0;
  const width = rows[0]?.length ?? 16,
    height = rows.length;
  return [16, 24, 32, 48, 64].map((size) => {
    const bytes = Buffer.alloc(size * size * 4);
    const scale = (size - (icon?.outline ? 2 : 0)) / Math.max(width, height);
    const left = (size - width * scale) / 2,
      top = (size - height * scale) / 2;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        bytes.writeUInt32BE(
          colors[rows[Math.floor((y + 0.5 - top) / scale)]?.[Math.floor((x + 0.5 - left) / scale)] ?? "."] ?? 0,
          (y * size + x) * 4,
        );
    if (icon?.outline) {
      const color = Number.parseInt(`ff${icon.outline.slice(1)}`, 16);
      const original = Buffer.from(bytes);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const offset = (y * size + x) * 4;
          if (original[offset]) continue;
          if (
            [
              [x - 1, y],
              [x + 1, y],
              [x, y - 1],
              [x, y + 1],
            ].some(
              ([a, b]) =>
                a !== undefined &&
                b !== undefined &&
                a >= 0 &&
                b >= 0 &&
                a < size &&
                b < size &&
                original[(b * size + a) * 4],
            )
          )
            bytes.writeUInt32BE(color, offset);
        }
    }
    return [size, size, bytes];
  });
}
