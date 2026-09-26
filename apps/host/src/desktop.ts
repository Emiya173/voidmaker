import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopAdapters } from "../../../packages/adapters/src/desktop.js";
import type { DesktopStore } from "../../../packages/adapters/src/desktop-store.js";
import {
  type DesktopGrants,
  type DesktopObservation,
  type DesktopPolicy,
  type DesktopSnapshot,
  type DesktopSource,
  desktopPolicy,
  noDesktopGrants,
} from "../../../packages/contracts/src/desktop.js";
import { excludedApp, hasDesktopGrant, observationPause } from "../../../packages/domain/src/desktop.js";

export type DesktopPorts = Readonly<{
  adapters: DesktopAdapters;
  store: Pick<DesktopStore, "start" | "save" | "audit">;
  publish: (snapshot: DesktopSnapshot) => void;
  present: () => boolean;
  idle: () => boolean;
  suggest: (context: string, signal: AbortSignal) => Promise<string>;
  revoked: () => void;
  now?: () => number;
}>;
type Observation = { view: DesktopObservation; imagePath?: string };
export class DesktopController {
  private policy: DesktopPolicy = desktopPolicy.parse({});
  private grants: DesktopGrants = noDesktopGrants;
  private observations: Observation[] = [];
  private revision = 0;
  private epoch = new AbortController();
  private automatic = false;
  private checkingLock = false;
  private activeAbort: AbortController | undefined;
  private active: Promise<unknown> | null = null;
  private mutations = Promise.resolve();
  private changing = 0;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private error = "";
  private pauseReason = "主动观察已关闭";
  private suggestion = "";
  private fingerprint = "";
  private nextCheckAt = 0;
  private readonly now: () => number;
  constructor(
    private readonly directory: string,
    private readonly ports: DesktopPorts,
  ) {
    this.now = ports.now ?? Date.now;
  }
  get snapshot(): DesktopSnapshot {
    return {
      revision: this.revision,
      policy: this.policy,
      grants: this.grants,
      observations: this.observations.map((o) => o.view),
      busy: !!this.active || this.changing > 0,
      pauseReason: this.pauseReason,
      error: this.error,
      suggestion: this.suggestion,
      nextCheckAt: this.nextCheckAt,
    };
  }
  private publish(): void {
    this.revision++;
    this.ports.publish(this.snapshot);
  }
  async start(schedule = true): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory))
      if (/^capture-[0-9a-f-]{36}\.png$/.test(file)) await unlink(join(this.directory, file));
    this.policy = await this.ports.store.start();
    if (schedule)
      this.timer = setInterval(() => {
        void this.tick().catch((error) => {
          this.error = message(error);
          this.publish();
        });
      }, 1000);
    this.publish();
  }
  private invalidate(): void {
    this.epoch.abort();
    this.epoch = new AbortController();
    this.ports.revoked();
    this.suggestion = "";
    this.fingerprint = "";
  }
  private async discard(): Promise<void> {
    const old = this.observations;
    this.observations = [];
    await Promise.all(old.map((o) => (o.imagePath ? unlink(o.imagePath).catch(() => undefined) : undefined)));
  }
  private change(kind: string, fn: () => { policy: DesktopPolicy; grants: DesktopGrants }): Promise<void> {
    this.changing++;
    this.invalidate();
    this.publish();
    const job = this.mutations
      .then(async () => {
        await this.active?.catch(() => undefined);
        const value = fn();
        await this.ports.store.save(value.policy, value.grants, kind);
        this.policy = value.policy;
        this.grants = value.grants;
        await this.discard();
        this.error = "";
        this.nextCheckAt = this.now() + this.policy.intervalSeconds * 1000;
      })
      .catch(async (error) => {
        await this.discard();
        this.grants = noDesktopGrants;
        this.policy = { ...this.policy, proactive: false };
        this.error = message(error);
        throw error;
      })
      .finally(() => {
        this.changing--;
        this.publish();
      });
    this.mutations = job.catch(() => undefined);
    return job;
  }
  grant(source: DesktopSource, minutes: number): Promise<void> {
    return this.change("grant", () => ({
      policy: this.policy,
      grants: { ...this.grants, [source]: this.now() + minutes * 60_000 },
    }));
  }
  revoke(source?: DesktopSource): Promise<void> {
    return this.change("revoke", () => ({
      policy: source ? this.policy : { ...this.policy, proactive: false },
      grants: source ? { ...this.grants, [source]: 0 } : noDesktopGrants,
    }));
  }
  configure(policy: DesktopPolicy): Promise<void> {
    return this.change("policy", () => ({ policy, grants: this.grants }));
  }
  async clear(): Promise<void> {
    this.invalidate();
    await this.discard();
    await this.ports.store.audit("clear", null);
    this.publish();
  }
  disconnected(): void {
    this.invalidate();
    void this.discard().then(() => this.publish());
  }
  private check(source: DesktopSource, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed || this.changing || !hasDesktopGrant(this.grants, source, this.now()))
      throw new Error("桌面授权未开启或已过期");
  }
  read(source: DesktopSource): Promise<void> {
    this.check(source, this.epoch.signal);
    if (this.active) throw new Error("桌面读取进行中，请先取消或等待完成");
    return this.run(async (signal) => {
      if (!(await this.ports.adapters.unlocked(signal))) throw new Error("会话已锁定、非活动或空闲，暂停桌面读取");
      await this.collect(source, signal);
    });
  }
  private run(fn: (signal: AbortSignal) => Promise<void>, automatic = false): Promise<void> {
    this.automatic = automatic;
    this.activeAbort = new AbortController();
    const signal = AbortSignal.any([this.epoch.signal, this.activeAbort.signal]);
    this.error = "";
    const operation = fn(signal)
      .catch((error) => {
        if (!signal.aborted) this.error = message(error);
      })
      .finally(() => {
        if (this.active === operation) this.active = null;
        this.publish();
      });
    this.active = operation;
    this.publish();
    return operation;
  }
  private async collect(source: DesktopSource, signal: AbortSignal): Promise<Observation | null> {
    this.check(source, signal);
    let text = "";
    let png: Buffer | undefined;
    if (source === "window") {
      const window = await this.ports.adapters.window(signal);
      this.check(source, signal);
      if (window && excludedApp(window.app_id, this.policy)) {
        this.pauseReason = "当前应用已排除";
        await this.discard();
        this.publish();
        return null;
      }
      text = window ? `应用：${window.app_id ?? "未知"}\n标题：${window.title ?? ""}` : "当前没有聚焦窗口";
    } else if (source === "media") text = await this.ports.adapters.media(signal);
    else {
      png = await this.ports.adapters.region(signal);
      text = `用户框选截图（${png.readUInt32BE(16)} × ${png.readUInt32BE(20)}）`;
    }
    this.check(source, signal);
    if (!(await this.ports.adapters.unlocked(signal))) throw new Error("会话已锁定，丢弃桌面读取结果");
    this.check(source, signal);
    const id = randomUUID();
    const imagePath = png ? join(this.directory, `capture-${id}.png`) : undefined;
    try {
      if (png && imagePath) await writeFile(imagePath, png, { mode: 0o600, flag: "wx" });
      await this.ports.store.audit("capture", source, {
        id,
        ...(png ? { sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length } : {}),
      });
      this.check(source, signal);
      const observation: Observation = {
        view: {
          id,
          source,
          provider: {
            window: "niri IPC · focused-window",
            media: "MPRIS · playerctl",
            region: "Wayland · slurp + grim",
          }[source],
          capturedAt: new Date(this.now()).toISOString(),
          expiresAt: new Date(Math.min(this.now() + 300_000, this.grants[source])).toISOString(),
          text,
          ...(imagePath ? { imageUrl: pathToFileURL(imagePath).href } : {}),
        },
        ...(imagePath ? { imagePath } : {}),
      };
      const previous = this.observations.filter((o) => o.view.source === source);
      this.observations = [...this.observations.filter((o) => o.view.source !== source), observation];
      await Promise.all(previous.map((o) => (o.imagePath ? unlink(o.imagePath).catch(() => undefined) : undefined)));
      this.publish();
      return observation;
    } catch (error) {
      if (imagePath) await unlink(imagePath).catch(() => undefined);
      throw error;
    }
  }
  async share(id: string): Promise<{ context: string; imageUrl?: string; signal: AbortSignal }> {
    const observation = this.observations.find((o) => o.view.id === id);
    if (!observation || Date.parse(observation.view.expiresAt) <= this.now())
      throw new Error("桌面上下文已清除或过期，请重新读取");
    const signal = this.epoch.signal;
    this.check(observation.view.source, signal);
    if (!(await this.ports.adapters.unlocked(signal))) throw new Error("会话已锁定，暂停分享桌面上下文");
    this.check(observation.view.source, signal);
    await this.ports.store.audit("share", observation.view.source, { id });
    this.check(observation.view.source, signal);
    const imageUrl = observation.imagePath
      ? `data:image/png;base64,${(await readFile(observation.imagePath)).toString("base64")}`
      : undefined;
    this.check(observation.view.source, signal);
    return {
      context: `来源：${observation.view.provider}\n采集：${observation.view.capturedAt}\n${observation.view.text}`,
      ...(imageUrl ? { imageUrl } : {}),
      signal,
    };
  }
  async tick(): Promise<void> {
    if (this.closed || this.changing) return;
    const now = this.now();
    const expired = Object.values(this.grants).some((expiry) => expiry > 0 && expiry <= now);
    if (expired) {
      await this.change("expire", () => ({
        policy: this.policy,
        grants: {
          window: this.grants.window > now ? this.grants.window : 0,
          media: this.grants.media > now ? this.grants.media : 0,
          region: this.grants.region > now ? this.grants.region : 0,
        },
      }));
      return;
    }
    if (this.observations.some((o) => Date.parse(o.view.expiresAt) <= now)) {
      const fingerprint = this.fingerprint;
      await this.clear();
      this.fingerprint = fingerprint;
    }
    const pause = observationPause(
      this.policy,
      this.grants,
      now,
      new Date(now).getHours(),
      this.ports.present(),
      this.ports.idle(),
    );
    if (pause) {
      if (this.active && this.automatic) this.activeAbort?.abort();
      if (this.pauseReason !== pause) {
        this.pauseReason = pause;
        this.publish();
      }
      return;
    }
    if (this.active && this.automatic && !this.checkingLock && this.activeAbort) {
      this.checkingLock = true;
      const operation = this.activeAbort;
      try {
        if (!(await this.ports.adapters.unlocked(AbortSignal.any([operation.signal, this.epoch.signal])))) {
          operation.abort();
          this.pauseReason = "会话已锁定、非活动或空闲";
          this.suggestion = "";
          this.publish();
        }
      } catch (error) {
        if (!operation.signal.aborted) {
          operation.abort();
          this.error = message(error);
          this.publish();
        }
      } finally {
        this.checkingLock = false;
      }
      return;
    }
    if (this.active || now < this.nextCheckAt) return;
    this.nextCheckAt = now + this.policy.intervalSeconds * 1000;
    await this.run(async (signal) => {
      if (!(await this.ports.adapters.unlocked(signal))) {
        this.pauseReason = "会话已锁定、非活动或空闲";
        return;
      }
      const observations: Observation[] = [];
      for (const source of ["window", "media"] as const) {
        if (!hasDesktopGrant(this.grants, source, this.now())) continue;
        const observation = await this.collect(source, signal);
        if (!observation) return;
        observations.push(observation);
      }
      signal.throwIfAborted();
      const context = observations.map((o) => `${o.view.provider}\n${o.view.text}`).join("\n\n");
      if (!context || context === this.fingerprint) {
        this.pauseReason = "桌面信息未变化";
        return;
      }
      await this.ports.store.audit("proactive", null, { observations: observations.map((o) => o.view.id) });
      signal.throwIfAborted();
      for (const observation of observations) this.check(observation.view.source, signal);
      if (this.observerPaused()) return;
      this.pauseReason = "正在检查是否需要建议";
      this.publish();
      const suggestion = await this.ports.suggest(context, signal);
      signal.throwIfAborted();
      for (const observation of observations) this.check(observation.view.source, signal);
      if (this.observerPaused() || !(await this.ports.adapters.unlocked(signal))) return;
      signal.throwIfAborted();
      this.fingerprint = context;
      this.suggestion = suggestion.slice(0, 2000);
      this.pauseReason = this.suggestion ? "有一条桌面建议" : "当前无需建议";
    }, true);
  }
  private observerPaused(): boolean {
    const now = this.now();
    return !!observationPause(
      this.policy,
      this.grants,
      now,
      new Date(now).getHours(),
      this.ports.present(),
      this.ports.idle(),
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.invalidate();
    await this.mutations;
    await this.active;
    await this.discard();
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
