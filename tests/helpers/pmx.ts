// An original three-vertex PMX fixture, independent of downloaded character assets.
export function trianglePmx(badIndex = false, restEyes = false, idle = false) {
  const chunks: Buffer[] = [];
  const byte = (...v: number[]) => {
    chunks.push(Buffer.from(v));
  };
  const uint = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    chunks.push(b);
  };
  const float = (...v: number[]) => {
    for (const n of v) {
      const b = Buffer.alloc(4);
      b.writeFloatLE(n);
      chunks.push(b);
    }
  };
  const string = (v: string) => {
    const b = Buffer.from(v, "utf16le");
    uint(b.length);
    chunks.push(b);
  };
  chunks.push(Buffer.from("PMX "));
  float(2);
  byte(8, 0, 0, 1, 1, 1, 1, 1, 1);
  for (const text of ["Triangle", "", "Original regression fixture", ""]) string(text);
  uint(3);
  for (const [i, pos] of [
    [1, 10, 0],
    [2, 10, 0],
    [1, 11, 0],
  ].entries()) {
    float(...pos, 0, 0, -1, 0, 0);
    byte(0, idle ? i + 5 : 1);
    float(i / 2);
  }
  uint(3);
  byte(0, 1, badIndex ? 99 : 2);
  uint(1);
  string("toon.png");
  uint(1);
  string("surface");
  string("");
  float(1, 1, 1, 1, 0, 0, 0, 50, 0.5, 0.5, 0.5);
  byte(16);
  float(0.1, 0.1, 0.1, 1, 1);
  byte(255, 255, 0, 0, 0);
  string("");
  uint(3);
  const bones = ["root", "左腕", "右腕", ...(idle ? ["上半身", "首", "頭", "左目", "右目"] : [])];
  uint(bones.length);
  for (const [i, name] of bones.entries()) {
    string(name);
    string("");
    float(i === 1 ? 1 : i === 2 ? -1 : 0, i ? 10 : 0, 0);
    byte(idle ? ([255, 3, 3, 0, 3, 4, 5, 5][i] ?? 255) : i ? 0 : 255);
    uint(0);
    byte(0, 0);
    float(0, 0, 0);
  }
  uint(restEyes ? 3 : 2);
  for (const name of ["あ", "まばたき", ...(restEyes ? ["neutral eyes"] : [])]) {
    string(name);
    string("");
    byte(1, 1);
    uint(1);
    byte(0);
    float(0, 0.1, 0);
  }
  uint(0);
  uint(0);
  uint(0);
  return Buffer.concat(chunks);
}
