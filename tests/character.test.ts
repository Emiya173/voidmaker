import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterController } from "../apps/host/src/character.js";
import { characterTts, defaultCharacter, loadCharacters } from "../packages/adapters/src/characters.js";
import { wavFromPcm } from "../packages/adapters/src/pcm.js";
import { characterDefinition } from "../packages/contracts/src/character.js";
import { characterPresentation } from "../packages/domain/src/character.js";
import { initialVoice, voiceTransition } from "../packages/domain/src/voice.js";

const paths: string[] = [];
it("requires an explicit auxiliary mode without adding defaults to existing character definitions", () => {
  const definition = {
    version: 1,
    id: "demo",
    name: "Demo",
    persona: "测试",
    voice: { reference: "ref.wav", promptText: "参考" },
  };
  expect(characterDefinition.parse(definition).voice).toEqual({
    ...definition.voice,
    promptLanguage: "zh",
    textLanguage: "auto",
  });
  const reference = { id: "gentle", description: "温柔", reference: "short.wav" };
  const withAuxiliary = (referenceMode?: string, auxiliaryReferences = [reference]) => ({
    ...definition,
    voice: { ...definition.voice, referenceMode, auxiliaryReferences },
  });
  expect(characterDefinition.safeParse(withAuxiliary()).success).toBe(false);
  expect(characterDefinition.safeParse(withAuxiliary("primary")).success).toBe(false);
  expect(characterDefinition.safeParse(withAuxiliary("auxiliary")).success).toBe(true);
  expect(
    characterDefinition.safeParse(withAuxiliary("auxiliary", [{ ...reference, reference: "../outside.wav" }])).success,
  ).toBe(false);
  expect(characterDefinition.safeParse(withAuxiliary("auxiliary", Array(25).fill(reference))).success).toBe(false);
});

it("pins short auxiliary audio and its portrait while retaining the fixed primary reference and legacy mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-auxiliary-"));
  paths.push(directory);
  const root = join(directory, "demo");
  await mkdir(root);
  const short = wavFromPcm(Buffer.alloc(32_000 * 0.62));
  await writeFile(join(root, "short.wav"), short);
  await writeFile(join(root, "ref.wav"), wavFromPcm(Buffer.alloc(32_000 * 4)));
  await writeFile(
    join(root, "gentle.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const definition = {
    version: 1,
    id: "demo",
    name: "Demo",
    persona: "测试",
    portraitExpressions: [{ id: "gentle", description: "温柔", image: "gentle.png" }],
    voice: {
      reference: "ref.wav",
      promptText: "固定主参考台词",
      promptLanguage: "ja",
      textLanguage: "ja",
      references: [{ id: "legacy", description: "原有参考", reference: "short.wav", promptText: "旧台词" }],
    },
  };
  await writeFile(
    join(root, "character.json"),
    JSON.stringify({
      ...definition,
      voice: {
        ...definition.voice,
        referenceMode: "auxiliary",
        auxiliaryReferences: [
          { id: "gentle", description: "温柔", reference: "short.wav", portraitId: "gentle" },
          { id: "calm", description: "平静", reference: "short.wav", portraitId: "neutral" },
        ],
      },
    }),
  );
  let catalog = await loadCharacters(directory);
  expect(catalog.warnings).toEqual([]);
  const reference = {
    refAudioPath: join(root, "short.wav"),
    kind: "auxiliary",
    sourceSha256: createHash("sha256").update(short).digest("hex"),
  };
  expect(catalog.entries[1]?.speechReferences).toEqual([
    { ...reference, id: "legacy", description: "原有参考" },
    { ...reference, id: "gentle", description: "温柔", portraitId: "gentle" },
    { ...reference, id: "calm", description: "平静", portraitId: "neutral" },
  ]);
  expect(catalog.entries[1]?.referenceMode).toBe("auxiliary");
  expect(catalog.entries[1]?.voice).toEqual({
    refAudioPath: join(root, "ref.wav"),
    promptText: "固定主参考台词",
    promptLanguage: "ja",
    textLanguage: "ja",
  });
  expect(catalog.entries[1]?.replyClips).toBeUndefined();
  expect(catalog.entries[1]?.waitingClips).toBeUndefined();
  await writeFile(join(root, "character.json"), JSON.stringify(definition));
  catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.referenceMode).toBeUndefined();
  expect(catalog.entries[1]?.speechReferences).toEqual([
    {
      id: "legacy",
      description: "原有参考",
      refAudioPath: join(root, "short.wav"),
      promptText: "旧台词",
      promptLanguage: "ja",
    },
  ]);
});

it("skips invalid, escaping and duplicate auxiliary audio and drops only broken portrait bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-auxiliary-invalid-"));
  paths.push(directory);
  const root = join(directory, "demo");
  await mkdir(root);
  const wav = wavFromPcm(Buffer.alloc(32_000));
  await writeFile(join(root, "short.wav"), wav);
  await writeFile(join(root, "bad.wav"), "invalid");
  await writeFile(join(root, "tiny.wav"), wavFromPcm(Buffer.alloc(3_200)));
  await writeFile(join(root, "long.wav"), wavFromPcm(Buffer.alloc(32_000 * 11)));
  await writeFile(join(directory, "outside.wav"), wav);
  await symlink(join(directory, "outside.wav"), join(root, "escape.wav"));
  const reference = { id: "calm", description: "平静", reference: "short.wav" };
  await writeFile(
    join(root, "character.json"),
    JSON.stringify({
      version: 1,
      id: "demo",
      name: "Demo",
      persona: "测试",
      portraitExpressions: [{ id: "broken", description: "失效立绘", image: "missing.png" }],
      voice: {
        reference: "short.wav",
        promptText: "主参考",
        referenceMode: "auxiliary",
        references: [{ ...reference, promptText: "旧台词" }],
        auxiliaryReferences: [
          reference,
          { ...reference, id: "neutral" },
          ...["bad", "tiny", "long", "escape", "missing"].map((id) => ({ ...reference, id, reference: `${id}.wav` })),
          { ...reference, id: "bad_binding", portraitId: "invented" },
          { ...reference, id: "broken_binding", portraitId: "broken" },
        ],
      },
    }),
  );
  const catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.speechReferences).toEqual(
    ["calm", "bad_binding", "broken_binding"].map((id) => ({
      id,
      description: "平静",
      refAudioPath: join(root, "short.wav"),
      kind: "auxiliary",
      sourceSha256: createHash("sha256").update(wav).digest("hex"),
    })),
  );
  expect(catalog.warnings).toHaveLength(10);
  expect(catalog.entries[1]?.voice?.refAudioPath).toBe(join(root, "short.wav"));
});

it("offers only valid local reply clips to the model and skips duplicate, reserved or broken clips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-openers-"));
  paths.push(directory);
  await mkdir(join(directory, "demo"));
  const wav = wavFromPcm(Buffer.alloc(32_000));
  await writeFile(join(directory, "demo", "short.wav"), wav);
  await writeFile(join(directory, "demo", "bad.wav"), "invalid");
  await writeFile(join(directory, "demo", "long.wav"), wavFromPcm(Buffer.alloc(32_000 * 6)));
  await writeFile(join(directory, "outside.wav"), wav);
  await symlink(join(directory, "outside.wav"), join(directory, "demo", "escape.wav"));
  const clip = { id: "apology", description: "道歉", text: "ごめんなさい。", subtitle: "对不起。", audio: "short.wav" };
  await writeFile(
    join(directory, "demo", "character.json"),
    JSON.stringify({
      version: 1,
      id: "demo",
      name: "Demo",
      persona: "测试",
      voice: {
        reference: "short.wav",
        promptText: "参考",
        replyClips: [
          clip,
          clip,
          { ...clip, id: "none" },
          ...["bad", "long", "escape"].map((id) => ({ ...clip, id, audio: `${id}.wav` })),
        ],
      },
    }),
  );
  const catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.replyClips).toEqual([
    { id: clip.id, description: clip.description, text: clip.text, subtitle: clip.subtitle, wav },
  ]);
  expect(catalog.entries[1]?.waitingClips).toBeUndefined();
  expect(catalog.warnings).toHaveLength(5);
});
it("loads short waiting clips separately from synthesis references and skips malformed clips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-waiting-"));
  paths.push(directory);
  await mkdir(join(directory, "demo"));
  const wav = wavFromPcm(Buffer.alloc(32_000));
  await writeFile(join(directory, "demo", "short.wav"), wav);
  await writeFile(join(directory, "demo", "bad.wav"), "invalid");
  await writeFile(join(directory, "demo", "long.wav"), wavFromPcm(Buffer.alloc(32_000 * 6)));
  await writeFile(
    join(directory, "demo", "character.json"),
    JSON.stringify({
      version: 1,
      id: "demo",
      name: "Demo",
      persona: "测试",
      voice: {
        reference: "short.wav",
        promptText: "参考",
        waitingClips: [
          { audio: "short.wav", subtitle: "嗯……" },
          { audio: "bad.wav", subtitle: "嗯……" },
          { audio: "long.wav", subtitle: "嗯……" },
        ],
      },
    }),
  );
  const catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.waitingClips).toEqual([{ wav, subtitle: "嗯……" }]);
  expect(catalog.entries[1]?.speechReferences).toBeUndefined();
  expect(catalog.warnings).toHaveLength(2);
});
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
    join(directory, "demo", "tray.json"),
    JSON.stringify({ rows: [".a.", "aaa"], palette: { a: "#ff0011" } }),
  );
  await writeFile(
    join(directory, "demo", "character.json"),
    JSON.stringify({
      version: 1,
      id: "demo",
      name: "Demo",
      persona: "test",
      portraits: { idle: "idle.png", layered: true },
      voice: { reference: "ref.wav", promptText: "你好" },
      portraitExpressions: [{ id: "gentle", description: "温柔回应", image: "idle.png" }],
      trayIcon: "tray.json",
    }),
  );
  const catalog = await loadCharacters(directory);
  expect(catalog.warnings).toEqual([]);
  expect(catalog.entries[1]?.layered).toBe(true);
  expect(catalog.entries[1]?.voice?.refAudioPath).toBe(join(directory, "demo", "ref.wav"));
  expect(catalog.entries[1]?.portraits.idle).toMatch(/^file:/);
  expect(catalog.entries[1]?.portraitExpressions?.[0]).toMatchObject({
    id: "gentle",
    imageUrl: expect.stringMatching(/^file:/),
  });
  expect(catalog.entries[1]?.trayIcon?.rows).toEqual([".a.", "aaa"]);
});

it("keeps a character usable when contextual images or tray pixel data are invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-expressions-"));
  paths.push(directory);
  await mkdir(join(directory, "demo"));
  await writeFile(join(directory, "demo", "tray.json"), JSON.stringify({ rows: ["unknown"], palette: {} }));
  await writeFile(
    join(directory, "demo", "character.json"),
    JSON.stringify({
      version: 1,
      id: "demo",
      name: "Demo",
      persona: "test",
      trayIcon: "tray.json",
      portraitExpressions: [{ id: "gentle", description: "温柔", image: "missing.png" }],
    }),
  );
  const catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.id).toBe("demo");
  expect(catalog.entries[1]?.portraitExpressions).toBeUndefined();
  expect(catalog.entries[1]?.trayIcon).toBeUndefined();
  expect(catalog.warnings).toHaveLength(2);
});

it("uses contextual portraits without a stale base layer and resets when switching sessions", async () => {
  const portrait = { id: "gentle", description: "温柔", imageUrl: "file:///gentle.png" };
  const character = {
    ...defaultCharacter,
    portraits: { idle: "base" },
    layered: true,
    portraitExpressions: [portrait],
  };
  const publish = vi.fn();
  const controller = new CharacterController(
    { entries: [character], warnings: [] },
    {
      idle: () => true,
      prepare: async (_character, _signal, sessionId) => ({ sessionId: sessionId ?? "s", threadId: "t" }),
      persist: async () => {},
      publish,
    },
  );
  await controller.select("default");
  const voice = initialVoice(false, false);
  controller.present("gentle");
  expect(controller.snapshot(voice, false).presentation).toMatchObject({
    imageUrl: portrait.imageUrl,
    baseUrl: "",
    expressionId: "gentle",
  });
  const count = publish.mock.calls.length;
  controller.present("gentle");
  expect(publish).toHaveBeenCalledTimes(count);
  expect(controller.snapshot({ ...voice, phase: "listening" }, false).presentation).toMatchObject({
    baseUrl: "base",
    imageUrl: "",
  });
  controller.present("invented");
  expect(controller.snapshot(voice, false).presentation.expressionId).toBe("neutral");
  controller.present("gentle");
  await controller.select("default", "other-session");
  expect(controller.snapshot(voice, false).presentation).toMatchObject({
    imageUrl: "",
    baseUrl: "base",
    expressionId: "neutral",
  });
  await controller.close();
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
it("uses a shared endpoint with character weights and restores the global pair for characters without weights", () => {
  const model = { gptWeightsPath: "/default.ckpt", sovitsWeightsPath: "/default.pth" };
  const tts = {
    url: "http://127.0.0.1:9880/tts",
    healthUrl: "http://127.0.0.1:9880/health",
    model,
    refAudioPath: "/ref.wav",
    promptText: "test",
    promptLanguage: "ja",
    textLanguage: "ja",
    timeoutMs: 120000,
  };
  const character = {
    ...defaultCharacter,
    voice: {
      ...tts,
      url: "http://127.0.0.1:9881/tts",
      model: { gptWeightsPath: "/chiaki.ckpt", sovitsWeightsPath: "/chiaki.pth" },
      refAudioPath: "/chiaki.wav",
    },
  };
  expect(characterTts(tts, character)).toMatchObject({
    url: tts.url,
    model: character.voice.model,
    refAudioPath: "/chiaki.wav",
  });
  expect(characterTts(tts, defaultCharacter)).toEqual(tts);
});

it("loads character weights inside the asset root and rejects incomplete or escaping pairs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-character-model-"));
  paths.push(directory);
  const root = join(directory, "model");
  await mkdir(root);
  await writeFile(join(root, "ref.wav"), Buffer.from("reference"));
  await writeFile(join(root, "gpt.ckpt"), "gpt");
  await writeFile(join(root, "sovits.pth"), "sovits");
  const definition = {
    version: 1,
    id: "model",
    name: "Model",
    persona: "test",
    voice: {
      reference: "ref.wav",
      promptText: "test",
      model: { gptWeightsPath: "gpt.ckpt", sovitsWeightsPath: "sovits.pth" },
    },
  };
  await writeFile(join(root, "character.json"), JSON.stringify(definition));
  expect((await loadCharacters(directory)).entries[1]?.voice?.model).toEqual({
    gptWeightsPath: join(root, "gpt.ckpt"),
    sovitsWeightsPath: join(root, "sovits.pth"),
  });
  await rm(join(root, "sovits.pth"));
  expect((await loadCharacters(directory)).entries).toHaveLength(1);
  await writeFile(join(directory, "outside.pth"), "outside");
  await symlink(join(directory, "outside.pth"), join(root, "sovits.pth"));
  expect((await loadCharacters(directory)).entries).toHaveLength(1);
});

it("isolates character endpoints and never inherits the other model's health URL", () => {
  const global = {
    url: "http://127.0.0.1:9880/tts",
    healthUrl: "http://127.0.0.1:9880/health",
    refAudioPath: "/old.wav",
    promptText: "old",
    promptLanguage: "zh",
    textLanguage: "auto",
    timeoutMs: 120000,
  };
  const character = {
    ...defaultCharacter,
    voice: {
      url: "http://127.0.0.1:9881/tts",
      refAudioPath: "/chiaki.wav",
      promptText: "test",
      promptLanguage: "ja",
      textLanguage: "auto",
    },
  };
  expect(characterTts(global, character)).toEqual({ ...character.voice, timeoutMs: 120000 });
  expect(characterTts(undefined, character)?.url).toBe(character.voice.url);
  expect(characterTts(undefined, defaultCharacter)).toBeUndefined();
  expect(
    characterDefinition.safeParse({
      version: 1,
      id: "x",
      name: "X",
      persona: "X",
      voice: {
        reference: "ref.wav",
        promptText: "test",
        url: "https://example.com/tts",
      },
    }).success,
  ).toBe(false);
});
it("falls back from missing or escaping 3D resources without losing the character", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-avatar-"));
  paths.push(directory);
  await mkdir(join(directory, "demo"));
  await mkdir(join(directory, "demo", "avatar"));
  await writeFile(
    join(directory, "demo", "character.json"),
    JSON.stringify({
      version: 1,
      id: "demo",
      name: "Demo",
      persona: "test",
      avatar: { kind: "quick3d", manifest: "avatar/avatar.json" },
    }),
  );
  await writeFile(
    join(directory, "demo", "avatar", "avatar.json"),
    JSON.stringify({
      height: 20,
      centerY: 10,
      parts: [{ mesh: "absent.mesh", color: [1, 1, 1, 1] }],
    }),
  );
  let catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.id).toBe("demo");
  expect(catalog.entries[1]?.avatar).toBeUndefined();
  expect(catalog.warnings).toEqual(["Demo：3D 素材不可用，使用立绘回退"]);
  await writeFile(join(directory, "outside.mesh"), Buffer.alloc(64));
  await symlink(join(directory, "outside.mesh"), join(directory, "demo", "avatar", "absent.mesh"));
  catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.avatar).toBeUndefined();
  expect(catalog.warnings).toHaveLength(1);
});
it("projects toon settings and rejects missing or escaping ramp textures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-toon-"));
  paths.push(directory);
  const root = join(directory, "demo");
  await mkdir(root);
  await writeFile(
    join(root, "character.json"),
    JSON.stringify({
      version: 1,
      id: "demo",
      name: "Demo",
      persona: "test",
      avatar: { kind: "quick3d", manifest: "avatar.json" },
    }),
  );
  const toon = {
    ambient: [0.5, 0.5, 0.5],
    specular: [0, 0, 0],
    shininess: 50,
    edgeColor: [0, 0, 0, 1],
    edgeSize: 1,
    ramp: "ramp.png",
  };
  const manifest = {
    height: 20,
    centerY: 10,
    width: 8,
    depth: 4,
    framing: { yaw: -5, zoom: 1.1, targetY: 0.1 },
    restEyes: 0.2,
    parts: [{ mesh: "model.mesh", color: [1, 1, 1, 1], toon, style: { tint: [0.9, 0.8, 0.7], textureStrength: 0.03 } }],
  };
  await writeFile(join(root, "avatar.json"), JSON.stringify(manifest));
  await writeFile(join(root, "model.mesh"), Buffer.alloc(64));
  expect((await loadCharacters(directory)).entries[1]?.avatar).toBeUndefined();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1UAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(root, "ramp.png"), png);
  let catalog = await loadCharacters(directory);
  expect(catalog.warnings).toEqual([]);
  expect(catalog.entries[1]?.avatar?.framing).toEqual(manifest.framing);
  expect(catalog.entries[1]?.avatar?.restEyes).toBe(0.2);
  expect(catalog.entries[1]?.avatar?.parts[0]?.style).toMatchObject({
    tint: [0.9, 0.8, 0.7],
    textureStrength: 0.03,
    outlineScale: 1,
  });
  expect(catalog.entries[1]?.avatar?.parts[0]?.toon?.rampUrl).toMatch(/\/demo\/ramp.png$/);
  await rm(join(root, "ramp.png"));
  await writeFile(join(directory, "outside.png"), png);
  await symlink(join(directory, "outside.png"), join(root, "ramp.png"));
  catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.avatar).toBeUndefined();
  expect(catalog.warnings).toHaveLength(1);
});
it("switches sessions within the same character without depending on TTS readiness", async () => {
  const prepareVoice = vi.fn(async () => {
    throw new Error("TTS is offline");
  });
  const controller = new CharacterController(
    { entries: [defaultCharacter], warnings: [] },
    {
      idle: () => true,
      prepare: async (character, _signal, sessionId) => ({ sessionId: sessionId ?? "initial", threadId: character.id }),
      prepareVoice,
      persist: async () => {},
      publish: () => {},
    },
  );
  await controller.select("default");
  await controller.select("default", "another");
  expect(controller.binding.sessionId).toBe("another");
  await controller.select("default", async () => "created");
  expect(controller.binding.sessionId).toBe("created");
  expect(prepareVoice).not.toHaveBeenCalled();
  await controller.close();
});

it("waits for voice model selection, preserves the old character on failure and ignores completion after shutdown", async () => {
  const other = { ...defaultCharacter, id: "other", name: "Other" };
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const prepareVoice = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  const persist = vi.fn(async () => {});
  const controller = new CharacterController(
    { entries: [defaultCharacter, other], warnings: [] },
    {
      idle: () => true,
      prepare: async (character) => ({ sessionId: character.id, threadId: character.id }),
      prepareVoice,
      persist,
      publish: vi.fn(),
    },
  );
  await controller.select("default");
  expect(prepareVoice).not.toHaveBeenCalled(); // Cold TTS must not block startup/text chat.
  const failed = controller.select("other");
  const rejection = expect(failed).rejects.toThrow("model failed");
  await vi.waitFor(() => expect(prepareVoice).toHaveBeenCalledTimes(1));
  fail(new Error("model failed"));
  await rejection;
  expect(controller.current.id).toBe("default");
  expect(persist).toHaveBeenCalledTimes(1);
  const pending = controller.select("other");
  await vi.waitFor(() => expect(prepareVoice).toHaveBeenCalledTimes(2));
  expect(controller.changing).toBe(true);
  expect(controller.current.id).toBe("default");
  expect(() => controller.select("default")).toThrow("停止");
  finish();
  await pending;
  expect(controller.current.id).toBe("other");
  const late = controller.select("default");
  const cancelled = expect(late).rejects.toThrow();
  await vi.waitFor(() => expect(prepareVoice).toHaveBeenCalledTimes(3));
  const closed = controller.close();
  finish();
  await cancelled;
  await closed;
  expect(controller.current.id).toBe("other");
  expect(persist).toHaveBeenCalledTimes(2);
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
