import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterController } from "../apps/host/src/character.js";
import { defaultCharacter, loadCharacters } from "../packages/adapters/src/characters.js";
import { characterDefinition } from "../packages/contracts/src/character.js";
import { characterPresentation } from "../packages/domain/src/character.js";
import { initialVoice, voiceTransition } from "../packages/domain/src/voice.js";

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("rejects traversal and unknown manifests, isolates broken packages and falls back for missing images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-characters-"));
  paths.push(directory);
  const definition = { version: 1, id: "demo", name: "Demo", persona: "测试角色" };
  expect(characterDefinition.safeParse({ ...definition, portraits: { idle: "../secret.png" } }).success).toBe(false);
  expect(characterDefinition.safeParse({ ...definition, id: "default" }).success).toBe(false);
  expect(characterDefinition.safeParse({ ...definition, version: 2 }).success).toBe(false);
  await mkdir(join(directory, "demo"));
  await mkdir(join(directory, "bad"));
  await writeFile(join(directory, "bad", "character.json"), "not json");
  await writeFile(
    join(directory, "demo", "character.json"),
    JSON.stringify({ ...definition, portraits: { idle: "absent.png" } }),
  );
  let catalog = await loadCharacters(directory);
  expect(catalog.entries.map((entry) => entry.id)).toEqual(["default", "demo"]);
  expect(catalog.entries[1]?.portraits).toEqual({});
  expect(catalog.warnings).toHaveLength(2);
  await writeFile(join(directory, "outside.wav"), "private");
  await symlink(join(directory, "outside.wav"), join(directory, "demo", "ref.wav"));
  await writeFile(
    join(directory, "demo", "character.json"),
    JSON.stringify({ ...definition, voice: { reference: "ref.wav", promptText: "test" } }),
  );
  catalog = await loadCharacters(directory);
  expect(catalog.entries.map((entry) => entry.id)).toEqual(["default"]);
});
it("loads layered local PNGs and a per-character reference without exposing persona in summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-characters-"));
  paths.push(directory);
  await mkdir(join(directory, "demo"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(directory, "demo", "idle.png"), png);
  await writeFile(join(directory, "demo", "ref.wav"), "audio fixture");
  await writeFile(
    join(directory, "demo", "character.json"),
    JSON.stringify({
      version: 1,
      id: "demo",
      name: "Demo",
      persona: "test",
      portraits: { idle: "idle.png", layered: true },
      voice: { reference: "ref.wav", promptText: "你好" },
    }),
  );
  const catalog = await loadCharacters(directory);
  expect(catalog.warnings).toEqual([]);
  expect(catalog.entries[1]?.layered).toBe(true);
  expect(catalog.entries[1]?.voice?.refAudioPath).toBe(join(directory, "demo", "ref.wav"));
  expect(catalog.entries[1]?.portraits.idle).toMatch(/^file:/);
});
it("drives mouth only from playback PCM, resets on stop and ignores late progress", () => {
  let voice = initialVoice(true, true);
  voice = voiceTransition(voice, { type: "begin", phase: "listening", continuous: false });
  voice = voiceTransition(voice, { type: "level", generation: 1, level: 0.5 });
  const portraits = { idle: "base", mouthOpen: "open" };
  expect(characterPresentation(portraits, voice, false).mouth).toBe(0);
  voice = voiceTransition(voice, { type: "stage", generation: 1, phase: "speaking", subtitle: "hello" });
  voice = voiceTransition(voice, { type: "progress", generation: 1, level: 0.1, position: 1, duration: 3 });
  expect(characterPresentation(portraits, voice, false, true)).toMatchObject({
    imageUrl: "open",
    baseUrl: "base",
    mouth: 1,
    subtitle: "hello",
  });
  voice = voiceTransition(voice, { type: "cancel" });
  voice = voiceTransition(voice, { type: "progress", generation: 1, level: 1, position: 2, duration: 3 });
  expect(characterPresentation(portraits, voice, false, true)).toMatchObject({
    imageUrl: "",
    baseUrl: "base",
    mouth: 0,
    subtitle: "",
  });
});
it("rejects concurrent/busy switches and retains the previous character on failure or late shutdown", async () => {
  const other = { ...defaultCharacter, id: "other", name: "Other" };
  let resolve!: (binding: { sessionId: string; threadId: string }) => void;
  const prepare = vi.fn(
    () =>
      new Promise<{ sessionId: string; threadId: string }>((done) => {
        resolve = done;
      }),
  );
  let idle = true;
  const persist = vi.fn(async () => {}),
    publish = vi.fn();
  const controller = new CharacterController(
    { entries: [defaultCharacter, other], warnings: [] },
    { idle: () => idle, prepare, persist, publish },
  );
  idle = false;
  expect(() => controller.select("other")).toThrow("停止");
  idle = true;
  const pending = controller.select("other");
  expect(() => controller.select("default")).toThrow("停止");
  const closed = controller.close();
  resolve({ sessionId: "other-session", threadId: "other-thread" });
  await expect(pending).rejects.toThrow();
  await closed;
  expect(controller.current.id).toBe("default");
  expect(persist).not.toHaveBeenCalled();
  const failed = new CharacterController(
    { entries: [defaultCharacter, other], warnings: [] },
    {
      idle: () => true,
      prepare: async () => ({ sessionId: "s", threadId: "t" }),
      persist: async () => {
        throw new Error("database unavailable");
      },
      publish,
    },
  );
  await expect(failed.select("other")).rejects.toThrow("database unavailable");
  expect(failed.current.id).toBe("default");
  expect(failed.changing).toBe(false);
});
