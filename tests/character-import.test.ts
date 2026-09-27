import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import { importCharacter, unpackCharacter } from "../apps/tools/src/characters/import.js";
import { convertPmx } from "../apps/tools/src/characters/pmx.js";

const yaml = strToU8(`- name: Example
  character_setting: Persona
  prompt_text: Reference
  prompt_lang: ja
  gpt_model_path: 'models\\voice.ckpt'
  sovits_model_path: 'models\\voice.pth'
  refer_audio_path: 'C:\\old-machine\\ref.wav'
  sprites:
    - path: './data/sprite\\idle.webp'
`);
it("maps Windows exporter paths without copying their absolute destinations", () => {
  const unpacked = unpackCharacter(zipSync({ "character.yaml": yaml, "models/ref.wav": strToU8("wav") }));
  expect(Buffer.from(unpacked.find(unpacked.info.refer_audio_path)).toString()).toBe("wav");
  const ambiguous = unpackCharacter(
    zipSync({ "character.yaml": yaml, "one/ref.wav": strToU8("a"), "two/ref.wav": strToU8("b") }),
  );
  expect(() => ambiguous.find("ref.wav")).toThrow("重名");
  expect(() => unpackCharacter(zipSync({ "../escape": strToU8("x") }))).toThrow("非法路径");
  expect(() => unpackCharacter(zipSync({ "character.yaml": strToU8("- invalid: true") }))).toThrow();
});
it("never overwrites an existing character when import fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "voidmaker-import-"));
  try {
    const source = join(root, "example.char"),
      existing = join(root, "existing");
    await writeFile(source, zipSync({ "character.yaml": yaml }));
    await writeFile(existing, "keep this");
    await expect(importCharacter(source, existing, "demo", "http://127.0.0.1:9881/tts")).rejects.toThrow();
    expect(await readFile(existing, "utf8")).toBe("keep this");
    await expect(importCharacter(source, join(root, "new"), "demo", "https://remote.invalid/tts")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("cleans partial PMX conversion and preserves existing destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "voidmaker-pmx-"));
  try {
    const source = join(root, "bad.pmx"),
      output = join(root, "avatar");
    await writeFile(source, "not a model");
    await expect(convertPmx(source, output)).rejects.toBeDefined();
    expect(await readdir(root)).toEqual(["bad.pmx"]);
    await writeFile(output, "existing");
    await expect(convertPmx(source, output)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("existing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
