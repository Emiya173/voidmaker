import { expect, it, vi } from "vitest";
import { SessionGuard } from "../apps/host/src/session-guard.js";

it("stops an active turn on lock independently of desktop observation", async () => {
  let unlocked = true;
  const check = vi.fn(async () => unlocked);
  const stop = vi.fn(async () => undefined);
  const guard = new SessionGuard(check, stop);
  try {
    guard.setActive(false);
    expect(check).not.toHaveBeenCalled();
    guard.setActive(true);
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    unlocked = false;
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce(), { timeout: 1500 });
  } finally {
    guard.close();
  }
});

it("does not let a late lock check stop a newer turn, and fails closed on probe errors", async () => {
  let resolve!: (value: boolean) => void;
  const old = new Promise<boolean>((done) => {
    resolve = done;
  });
  const check = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce(new Error("unavailable"));
  const stop = vi.fn(async () => undefined);
  const guard = new SessionGuard(check, stop);
  try {
    guard.setActive(true);
    guard.setActive(false);
    guard.setActive(true);
    resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    guard.setActive(false);
    guard.setActive(true);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  } finally {
    guard.close();
  }
});
