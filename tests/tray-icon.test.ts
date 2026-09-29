import { expect, it } from "vitest";
import { trayPixmaps } from "../packages/adapters/src/tray-icon.js";
import { pixelIcon } from "../packages/contracts/src/tray-icon.js";

it("validates rectangular pixel maps and defined palette entries", () => {
  expect(pixelIcon.safeParse({ rows: ["aa", "a"], palette: { a: "#abcdef" } }).success).toBe(false);
  expect(pixelIcon.safeParse({ rows: ["b"], palette: { a: "#abcdef" } }).success).toBe(false);
  expect(pixelIcon.safeParse({ rows: ["a"], palette: { a: "red" } }).success).toBe(false);
});

it("centers character pixel art and emits network-order ARGB with a one-pixel outline", () => {
  const icon = pixelIcon.parse({
    rows: [".a.", ".a.", ".a."],
    palette: { a: "#123456", ".": "#ffffff" },
    outline: "#000000",
  });
  const maps = trayPixmaps(icon);
  expect(maps.map(([width]) => width)).toEqual([16, 24, 32, 48, 64]);
  for (const [width, height, data] of maps) {
    expect(data.length).toBe(width * height * 4);
    const center = data.readUInt32BE(((height / 2) * width + width / 2) * 4);
    expect(center).toBe(0xff123456);
    expect(data.readUInt32BE(0)).toBe(0);
    const middle = Array.from({ length: width }, (_, x) => data.readUInt32BE(((height / 2) * width + x) * 4));
    expect(middle).toEqual([...middle].reverse());
    expect(middle.filter((color) => color === 0xff000000)).toHaveLength(2);
  }
});
