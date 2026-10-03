import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadApplicationConfig, prepareCodexHome } from "../packages/adapters/src/application-config.js";

it("loads independent role settings and rejects broken TOML instead of falling back to Codex", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voidmaker-config-"));
  try {
    const path = join(dir, "config.toml");
    const defaults = await loadApplicationConfig(path);
    expect(defaults.agent).toEqual({ model: "gpt-6-sol", reasoning_effort: "medium" });
    expect(defaults.screen_awareness).toEqual({ precheck_model: "gpt-6-luna", precheck_reasoning_effort: "high" });
    expect(defaults.speech.reviewed_datasets).toEqual({});
    await writeFile(
      path,
      '[agent]\nmodel="chat-test"\nreasoning_effort="low"\n[screen_awareness]\nprecheck_model="observer-test"\nprecheck_reasoning_effort="high"\n',
    );
    expect((await loadApplicationConfig(path)).agent.model).toBe("chat-test");
    await writeFile(path, '[speech.reviewed_datasets]\nchiaki="/corpus/dataset.jsonl"');
    expect((await loadApplicationConfig(path)).speech.reviewed_datasets).toEqual({ chiaki: "/corpus/dataset.jsonl" });
    await writeFile(path, '[speech.reviewed_datasets]\nchiaki="relative/dataset.jsonl"');
    await expect(loadApplicationConfig(path)).rejects.toThrow("绝对路径");
    await writeFile(path, '[agent]\nreasoning_effort="invalid"');
    await expect(loadApplicationConfig(path)).rejects.toThrow("配置无效");
    await writeFile(path, "[agent");
    await expect(loadApplicationConfig(path)).rejects.toThrow("配置无效");
    const auth = join(dir, "login.json");
    await writeFile(auth, '{"fixture":true}', { mode: 0o600 });
    const home = await prepareCodexHome(join(dir, "engine"), auth);
    await prepareCodexHome(home, auth);
    expect(await readlink(join(home, "auth.json"))).toBe(auth);
    await expect(readFile(join(home, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
