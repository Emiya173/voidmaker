export class SessionGuard {
  private epoch: AbortController | undefined;
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly check: (signal: AbortSignal) => Promise<boolean>,
    private readonly stop: () => Promise<void>,
  ) {}

  setActive(active: boolean): void {
    if (active === !!this.epoch) return;
    this.close();
    if (active) {
      const epoch = new AbortController();
      this.epoch = epoch;
      void this.poll(epoch);
    }
  }
  private async poll(epoch: AbortController): Promise<void> {
    let active = false;
    try {
      active = await this.check(epoch.signal);
    } catch {
      /* Unavailable session state closes capture. */
    }
    if (epoch.signal.aborted || this.epoch !== epoch) return;
    if (!active) {
      this.close();
      await this.stop();
    } else
      this.timer = setTimeout(() => {
        void this.poll(epoch);
      }, 1000);
  }
  close(): void {
    this.epoch?.abort();
    this.epoch = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
