import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.env.VOIDMAKER_SYSTEMD_SMOKE !== "1")(
  "stops the whole stack on target stop, Shell exit and Host stop using real systemd dependencies",
  async () => {
    const run = promisify(execFile);
    const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args], { timeout: 15000 });
    const root = await mkdtemp(join(tmpdir(), "voidmaker-lifecycle-"));
    const prefix = `voidmaker-test-${randomUUID().slice(0, 8)}`;
    const services = ["shell", "host", "asr", "tts", "postgres"].map((name) => `${prefix}-${name}.service`);
    const names = [`${prefix}.target`, ...services];
    const paths: string[] = [];
    for (const name of names) {
      const original = name.replace(prefix, "voidmaker");
      const source = await readFile(
        original === "voidmaker-host.service" ? `docs/${original}` : `docs/systemd/${original}`,
        "utf8",
      );
      const contents = source
        .replaceAll("voidmaker", prefix)
        .replace(/^(WorkingDirectory|Environment|RuntimeDirectory|RuntimeDirectoryMode|ExecStartPost)=.*\n/gm, "")
        .replace(/^ExecStart=.*$/gm, `ExecStart=${process.execPath} -e "setInterval(()=>{},1000)"`)
        .replace(/^RestartSec=.*$/gm, "RestartSec=0.1");
      const path = join(root, name);
      await writeFile(path, contents);
      paths.push(path);
    }
    const state = async (name: string) =>
      (await systemctl("show", name, "--property=ActiveState", "--value")).stdout.trim();
    const stopped = async () => {
      await expect
        .poll(async () => (await Promise.all(names.map(state))).every((s) => s === "inactive" || s === "failed"), {
          timeout: 10000,
        })
        .toBe(true);
    };
    const started = async () => {
      await systemctl("start", `${prefix}.target`);
      await expect
        .poll(async () => (await Promise.all(names.map(state))).every((s) => s === "active"), { timeout: 5000 })
        .toBe(true);
    };
    try {
      await systemctl("link", "--runtime", ...paths);
      await systemctl("daemon-reload");
      await started();
      await systemctl("stop", `${prefix}.target`);
      await stopped();
      await started();
      await systemctl("kill", "--signal=SIGTERM", `${prefix}-shell.service`);
      await stopped();
      await started();
      await systemctl("stop", `${prefix}-host.service`);
      await stopped();
    } finally {
      await systemctl("stop", ...names).catch(() => undefined);
      for (const name of names)
        await unlink(
          join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`, "systemd/user", name),
        ).catch(() => undefined);
      await systemctl("daemon-reload");
      await systemctl("reset-failed", ...names).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
