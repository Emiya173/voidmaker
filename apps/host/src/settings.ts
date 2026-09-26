import type { VoiceSettingsStore } from "../../../packages/adapters/src/voice-settings.js";
import type { SettingsSnapshot } from "../../../packages/contracts/src/settings.js";
import type { VoiceConfig } from "../../../packages/contracts/src/voice.js";

type Ports = Readonly<{
  idle: () => boolean;
  prepare: () => Promise<void>;
  apply: (config: VoiceConfig) => void;
  publish: (value: SettingsSnapshot) => void;
}>;
export class SettingsController {
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private state: SettingsSnapshot,
    private readonly store: VoiceSettingsStore,
    private readonly ports: Ports,
  ) {}
  get snapshot(): SettingsSnapshot {
    return this.state;
  }
  change(
    action:
      | { type: "save"; revision: string; config: VoiceConfig }
      | { type: "restore"; revision: string }
      | { type: "reload" },
  ): Promise<void> {
    if (this.closed) throw new Error("服务正在关闭");
    if (this.state.busy || !this.ports.idle()) throw new Error("请先停止当前对话或录音，再修改设置");
    if (action.type !== "reload" && action.revision !== this.state.revision)
      throw new Error("设置版本已改变，请重新读取");
    this.state = { ...this.state, busy: true };
    this.ports.publish(this.state);
    this.pending = this.update(action);
    return this.pending;
  }
  private async update(action: Parameters<SettingsController["change"]>[0]): Promise<void> {
    try {
      await this.ports.prepare();
      if (this.closed) return;
      const next =
        action.type === "save"
          ? await this.store.save(action.revision, action.config)
          : action.type === "restore"
            ? await this.store.restore(action.revision)
            : await this.store.load();
      if (this.closed) return;
      if (action.type === "reload" && next.error) throw new Error(next.error);
      this.state = { ...next, busy: true };
      this.ports.apply(next.config);
    } finally {
      this.state = { ...this.state, busy: false };
      if (!this.closed) this.ports.publish(this.state);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.pending.catch(() => undefined);
  }
}
