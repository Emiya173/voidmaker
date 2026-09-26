import type { AudioDevice, DiagnosticResult, DiagnosticsSnapshot } from "../../../packages/contracts/src/settings.js";
export const initialDiagnostics: DiagnosticsSnapshot = {
  generation: 0,
  phase: "idle",
  checkedAt: null,
  results: [],
  devices: [],
};
type Probe = Readonly<{ id: string; label: string; run: (signal: AbortSignal) => Promise<DiagnosticResult> }>;
export class DiagnosticsController {
  snapshot: DiagnosticsSnapshot = initialDiagnostics;
  private controller: AbortController | undefined;
  constructor(private readonly publish: (snapshot: DiagnosticsSnapshot) => void) {}
  start(probes: readonly Probe[], devices: (signal: AbortSignal) => Promise<readonly AudioDevice[]>): void {
    this.cancel(false);
    const controller = new AbortController();
    this.controller = controller;
    const generation = this.snapshot.generation + 1;
    this.snapshot = { generation, phase: "running", checkedAt: null, results: [], devices: [] };
    this.publish(this.snapshot);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    const run = async () => {
      const results = await Promise.all(
        allProbes.map(async (probe) => {
          try {
            return await this.bounded(probe.run(signal), signal);
          } catch (error) {
            return {
              id: probe.id,
              label: probe.label,
              status: "error" as const,
              detail: error instanceof Error ? error.message : "检查失败",
            };
          }
        }),
      );
      if (this.controller !== controller || controller.signal.aborted) return;
      this.snapshot = { ...this.snapshot, phase: "complete", checkedAt: new Date().toISOString(), results };
      this.publish(this.snapshot);
    };
    const allProbes: readonly Probe[] = [
      ...probes,
      {
        id: "devices",
        label: "音频设备",
        run: async (active) => {
          const found = await devices(active);
          if (this.controller === controller && !active.aborted) this.snapshot = { ...this.snapshot, devices: found };
          return {
            id: "devices",
            label: "音频设备",
            status: "ready",
            detail: `发现 ${found.filter((d) => d.kind === "input").length} 个输入、${found.filter((d) => d.kind === "output").length} 个输出；未采集音频`,
          };
        },
      },
    ];
    void run();
  }
  private bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("检查超时或已取消"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
  cancel(publish = true): void {
    this.controller?.abort();
    this.controller = undefined;
    this.snapshot = {
      ...this.snapshot,
      generation: this.snapshot.generation + 1,
      phase: this.snapshot.phase === "running" ? "cancelled" : this.snapshot.phase,
    };
    if (publish) this.publish(this.snapshot);
  }
  clear(): void {
    this.cancel(false);
    this.snapshot = { ...initialDiagnostics, generation: this.snapshot.generation };
    this.publish(this.snapshot);
  }
}
