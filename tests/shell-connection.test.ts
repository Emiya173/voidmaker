import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.env.VOIDMAKER_SHELL_SMOKE !== "1")(
  "reconnects real Quickshell after a missing socket and a server restart",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "voidmaker-shell-test-"));
    const socketPath = join(directory, "host.sock");
    await copyFile("apps/shell/HostConnection.qml", join(directory, "HostConnection.qml"));
    await writeFile(
      join(directory, "shell.qml"),
      `import Quickshell
ShellRoot {
 HostConnection {
  id: connection
  path: ${JSON.stringify(socketPath)}
  onConnectedChanged: { console.log(connected ? "TEST_CONNECTED" : "TEST_DISCONNECTED"); if (connected) send({type: "hello", version: 8}) }
  onMessage: line => console.log("TEST_FRAME:" + line)
 }
}`,
    );
    let log = "";
    const child = spawn("quickshell", ["--path", join(directory, "shell.qml")], {
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      log += data.toString();
    });
    child.stderr.on("data", (data) => {
      log += data.toString();
    });
    child.on("error", (error) => {
      log += error.message;
    });
    const clients = new Set<Socket>();
    const hello: unknown[] = [];
    let epoch = 1;
    const server = createServer((socket) => {
      clients.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => clients.delete(socket));
      socket.on("data", (data) => {
        hello.push(JSON.parse(data.toString()));
        socket.write(`${JSON.stringify({ epoch })}\n`);
      });
    });
    try {
      await expect.poll(() => log, { timeout: 5000 }).toContain("ServerNotFoundError");
      server.listen(socketPath);
      await once(server, "listening");
      await expect.poll(() => log, { timeout: 6000 }).toContain('TEST_FRAME:{"epoch":1}');
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await expect.poll(() => log, { timeout: 5000 }).toContain("TEST_DISCONNECTED");
      epoch = 2;
      server.listen(socketPath);
      await once(server, "listening");
      await expect.poll(() => log, { timeout: 6000 }).toContain('TEST_FRAME:{"epoch":2}');
      expect(hello).toEqual([
        { type: "hello", version: 8 },
        { type: "hello", version: 8 },
      ]);
      expect(log).not.toMatch(/ReferenceError|TypeError|Failed to load configuration/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
      for (const client of clients) client.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true });
    }
  },
  20000,
);
