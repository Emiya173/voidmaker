import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.env.VOIDMAKER_TRAY_SMOKE !== "1")(
  "exports an actionable menu, ignores non-click events and re-registers after watcher restart",
  async () => {
    const result = await promisify(execFile)(
      "dbus-run-session",
      ["--", process.execPath, "--import", "tsx", "tests/fixtures/tray-smoke.mjs"],
      { timeout: 15000, env: { ...process.env, VOIDMAKER_TRAY: "1" } },
    );
    expect(result.stdout).toContain("TRAY_PASSED");
  },
  20000,
);
