import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopController, type DesktopPorts } from "../apps/host/src/desktop.js";
import { desktopAdapters, desktopCommand } from "../packages/adapters/src/desktop.js";
import { desktopPolicy, noDesktopGrants } from "../packages/contracts/src/desktop.js";
import { excludedApp, observationPause } from "../packages/domain/src/desktop.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-desktop-test-"));
  cleanup.push(() => rm(directory, { recursive: true }));
  let now = new Date(2026, 8, 26, 12).getTime();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=",
    "base64",
  );
  const ports = {
    adapters: {
      window: vi.fn(async () => ({ id: 1, app_id: "test", title: "private window" })),
      media: vi.fn(async () => "private media"),
      region: vi.fn(async () => png),
      unlocked: vi.fn(async () => true),
    },
    store: {
      start: vi.fn(async () => desktopPolicy.parse({})),
      save: vi.fn(async () => undefined),
      audit: vi.fn(async () => undefined),
    },
    publish: vi.fn(),
    present: vi.fn(() => true),
    idle: vi.fn(() => true),
    suggest: vi.fn<DesktopPorts["suggest"]>(async () => "建议"),
    revoked: vi.fn(),
    now: () => now,
  } satisfies DesktopPorts;
  const controller = new DesktopController(directory, ports);
  cleanup.push(() => controller.close());
  await controller.start(false);
  return {
    controller,
    ports,
    directory,
    advance: (ms = 60_000) => {
      now += ms;
    },
    async enable() {
      await controller.grant("window", 60);
      await controller.configure(desktopPolicy.parse({ proactive: true, intervalSeconds: 60 }));
      now += 60_000;
    },
  };
}

describe("desktop grants and observation", () => {
  it("gates overnight hours, equal hours, exclusions and denied sources", () => {
    const grants = { ...noDesktopGrants, window: 100 };
    const policy = desktopPolicy.parse({ proactive: true, startHour: 22, endHour: 6 });
    expect(observationPause(policy, grants, 1, 23, true, true)).toBe("");
    expect(observationPause(policy, grants, 1, 12, true, true)).toContain("时段");
    expect(observationPause({ ...policy, endHour: 22 }, grants, 1, 22, true, true)).toContain("时段");
    expect(observationPause(policy, grants, 100, 23, true, true)).toContain("授权");
    expect(excludedApp("ORG.KEEPASSXC.KEEPASSXC", policy)).toBe(true);
  });
  it("does not access denied inputs or models, expires grants, and excludes private windows", async () => {
    const f = await fixture();
    expect(() => f.controller.read("window")).toThrow("授权");
    await f.controller.tick();
    expect(f.ports.adapters.unlocked).not.toHaveBeenCalled();
    await f.controller.grant("window", 1);
    f.ports.adapters.window.mockResolvedValue({ id: 1, app_id: "org.keepassxc.KeePassXC", title: "secret" });
    await f.controller.read("window");
    expect(f.controller.snapshot.observations).toEqual([]);
    f.advance();
    await f.controller.tick();
    expect(f.controller.snapshot.grants.window).toBe(0);
    expect(f.ports.suggest).not.toHaveBeenCalled();
  });
  it("discards a late completion after revocation and fails closed on persistence errors", async () => {
    const f = await fixture();
    await f.controller.grant("window", 15);
    const late = pending<{ id: number; app_id: string; title: string }>();
    f.ports.adapters.window.mockReturnValue(late.promise);
    const reading = f.controller.read("window");
    await vi.waitFor(() => expect(f.ports.adapters.window).toHaveBeenCalled());
    const revoking = f.controller.revoke();
    late.resolve({ id: 1, app_id: "test", title: "late" });
    await Promise.all([reading, revoking]);
    expect(f.controller.snapshot.observations).toEqual([]);
    expect(f.ports.store.audit).not.toHaveBeenCalled();
    f.ports.store.save.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.controller.grant("media", 15)).rejects.toThrow("database unavailable");
    expect(f.controller.snapshot.grants).toEqual(noDesktopGrants);
  });
  it("keeps screenshot local until explicit share and deletes files on revocation", async () => {
    const f = await fixture();
    await f.controller.grant("region", 15);
    await f.controller.read("region");
    const observation = f.controller.snapshot.observations[0];
    expect(observation?.source).toBe("region");
    if (!observation?.imageUrl) throw new Error("missing preview");
    expect((await stat(new URL(observation.imageUrl))).mode & 0o777).toBe(0o600);
    expect(f.ports.suggest).not.toHaveBeenCalled();
    const shared = await f.controller.share(observation.id);
    expect(shared.imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(f.ports.store.audit.mock.calls)).not.toContain("base64");
    await f.controller.revoke();
    expect(shared.signal.aborted).toBe(true);
    expect(await readdir(f.directory)).toEqual([]);
    await expect(f.controller.share(observation.id)).rejects.toThrow("过期");
  });
  it("pauses for absent UI, ongoing chat and locks; never captures a screenshot automatically", async () => {
    const f = await fixture();
    await f.enable();
    await f.controller.grant("region", 15);
    f.advance();
    f.ports.present.mockReturnValue(false);
    await f.controller.tick();
    f.ports.present.mockReturnValue(true);
    f.ports.idle.mockReturnValue(false);
    await f.controller.tick();
    expect(f.ports.adapters.window).not.toHaveBeenCalled();
    f.ports.idle.mockReturnValue(true);
    f.ports.adapters.unlocked.mockResolvedValue(false);
    await f.controller.tick();
    expect(f.ports.adapters.window).not.toHaveBeenCalled();
    f.ports.adapters.unlocked.mockResolvedValue(true);
    f.advance();
    await f.controller.tick();
    expect(f.ports.suggest).toHaveBeenCalledTimes(1);
    expect(f.ports.adapters.region).not.toHaveBeenCalled();
    expect(f.ports.adapters.media).not.toHaveBeenCalled();
    expect(JSON.stringify(f.ports.store.audit.mock.calls)).not.toContain("private window");
    f.advance(300_000);
    await f.controller.tick();
    expect(f.ports.suggest).toHaveBeenCalledTimes(1);
  });
  it("cancels an in-flight suggestion on lock and suppresses a stale model response", async () => {
    const f = await fixture();
    await f.enable();
    const result = pending<string>();
    f.ports.suggest.mockReturnValue(result.promise);
    const checking = f.controller.tick();
    await vi.waitFor(() => expect(f.ports.suggest).toHaveBeenCalled());
    const signal = f.ports.suggest.mock.calls[0]?.[1];
    f.ports.adapters.unlocked.mockResolvedValue(false);
    await f.controller.tick();
    expect(signal?.aborted).toBe(true);
    result.resolve("late private suggestion");
    await checking;
    expect(f.controller.snapshot.suggestion).toBe("");
  });
});

describe("desktop process boundaries", () => {
  it("bounds output, reaps cancellation, and distinguishes missing tools", async () => {
    await expect(
      desktopCommand(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(1000))"],
        new AbortController().signal,
        10,
      ),
    ).rejects.toThrow("输出过大");
    const abort = new AbortController();
    const running = desktopCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], abort.signal);
    abort.abort();
    await expect(running).rejects.toThrow("取消");
    await expect(desktopCommand("/missing/voidmaker-tool", [], new AbortController().signal)).rejects.toThrow("不可用");
  });
  it("rejects malformed IPC and slurp geometry before calling grim", async () => {
    const run = vi.fn(async () => Buffer.from("invalid"));
    const adapters = desktopAdapters(run);
    await expect(adapters.window(new AbortController().signal)).rejects.toThrow();
    await expect(adapters.region(new AbortController().signal)).rejects.toThrow("区域无效");
    expect(run.mock.calls).toHaveLength(2);
  });
});
