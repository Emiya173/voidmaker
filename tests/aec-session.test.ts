import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { openAecSession } from "../packages/adapters/src/aec-session.js";
import { playAudio } from "../packages/adapters/src/audio-process.js";
import { readWav, wavFromPcm } from "../packages/adapters/src/pcm.js";
import { pipeWireGraphSchema } from "../packages/adapters/src/pipewire-graph.js";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";

const exec = promisify(execFile);
const enabled = process.env.VOIDMAKER_AEC_SMOKE === "1";
const pkg = process.env.VOIDMAKER_AEC_PACKAGE;

// Opt-in real PipeWire test. Every input/output is virtual; never use a physical microphone.
it.skipIf(!enabled)(
  "loads native AEC, preserves preroll, tracks volume and closes on device removal",
  async () => {
    if (!pkg) throw new Error("需要 VOIDMAKER_AEC_PACKAGE");
    const graph = async () => pipeWireGraphSchema.parse(JSON.parse((await exec("pw-dump")).stdout));
    const initial = await graph();
    const physical = new Set(initial.filter((n) => n.info?.props?.["device.id"] !== undefined).map((n) => n.id));
    const prefix = `voidmaker-virtual-test-${process.pid}`;
    const directory = await mkdtemp(join(tmpdir(), "voidmaker-aec-"));
    const children: { child: ChildProcess; done: Promise<void> }[] = [];
    let session: Awaited<ReturnType<typeof openAecSession>> | undefined;
    const playbackAbort = new AbortController();
    let playbackCleanup: Promise<void> | undefined;
    const launch = (args: string[]) => {
      const child = spawn("pw-cli", ["--monitor", ...args], { stdio: ["pipe", "ignore", "pipe"] });
      const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.on("error", () => undefined);
      child.stderr?.resume();
      children.push({ child, done });
      return child;
    };
    const common = { "node.virtual": true, "node.hidden": true, "priority.session": 0, "state.restore-props": false };
    try {
      launch([
        "load-module",
        "libpipewire-module-loopback",
        JSON.stringify({
          "audio.rate": 48000,
          "audio.channels": 1,
          "audio.position": ["MONO"],
          "capture.props": {
            ...common,
            "node.name": `${prefix}.feed`,
            "media.class": "Audio/Sink",
            "node.autoconnect": false,
          },
          "playback.props": {
            ...common,
            "node.name": `${prefix}.mic`,
            "media.class": "Audio/Source",
            "node.autoconnect": false,
          },
        }),
      ]);
      const speaker = launch([
        "create-node",
        "adapter",
        JSON.stringify({
          ...common,
          "factory.name": "support.null-audio-sink",
          "node.name": `${prefix}.speaker`,
          "media.class": "Audio/Sink",
          "audio.rate": 48000,
          "audio.position": ["MONO"],
          "object.linger": false,
        }),
      ]);
      let sinkId = 0;
      await expect
        .poll(
          async () => {
            sinkId = (await graph()).find((n) => n.info?.props?.["node.name"] === `${prefix}.speaker`)?.id ?? 0;
            return sinkId;
          },
          { timeout: 3000 },
        )
        .toBeGreaterThan(0);
      await exec("pw-cli", [
        "set-param",
        String(sinkId),
        "Props",
        JSON.stringify({ channelVolumes: [0.02], softVolumes: [0.02] }),
      ]);
      const config = voiceConfigSchema.parse({
        inputTarget: `${prefix}.mic`,
        aec: { pluginDirectory: join(pkg, "lib/spa-0.2"), outputTarget: `${prefix}.speaker`, bargeIn: true },
        vad: { silenceMs: 300 },
      });
      const rawPackets: Buffer[] = [];
      session = await openAecSession(config, new AbortController().signal, {
        onPacket: (packet) => {
          if (packet.lane === "raw") rawPackets.push(Buffer.from(packet.pcm));
        },
      });
      const nodes = await graph();
      const own = nodes.filter((n) =>
        String(n.info?.props?.["node.name"]).startsWith(`voidmaker-session-${process.pid}-`),
      );
      const ownIds = new Set(own.map((n) => n.id));
      for (const n of nodes) {
        const props = n.info?.props;
        const source = Number(props?.["link.output.node"]),
          target = Number(props?.["link.input.node"]);
        if (ownIds.has(source) || ownIds.has(target)) {
          expect(physical.has(source) || physical.has(target)).toBe(false);
        }
      }
      expect(own.length).toBeGreaterThanOrEqual(3);
      const reference = own.find((n) => String(n.info?.props?.["node.name"]).endsWith(".reference"));
      expect(reference).toBeDefined();
      await exec("pw-cli", [
        "set-param",
        String(sinkId),
        "Props",
        JSON.stringify({ channelVolumes: [0.04], softVolumes: [0.04] }),
      ]);
      await expect
        .poll(
          async () => {
            const node = (await graph()).find((n) => n.id === reference?.id);
            return (node?.info?.params?.Props?.[0] as { volume?: number })?.volume;
          },
          { timeout: 3000 },
        )
        .toBeCloseTo(0.04, 5);
      // A deterministic sine exercises transport/trigger, not speech intelligibility.
      const pcm = Buffer.alloc(16000 * 2 * 2);
      for (let i = 0; i < 16000; i++)
        pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 330) / 16000) * 12000), i * 2);
      const audio = join(directory, "synthetic.wav");
      await writeFile(audio, wavFromPcm(pcm), { mode: 0o600 });
      const playInput = () =>
        exec("pw-play", [
          "--properties",
          JSON.stringify({ "node.dont-fallback": true, "node.dont-reconnect": true }),
          "--target",
          `${prefix}.feed`,
          audio,
        ]);
      const normal = session.capture(new AbortController().signal, () => {}).result;
      await playInput();
      const ordinaryPcm = readWav(await normal).pcm;
      expect(Buffer.concat(rawPackets).indexOf(ordinaryPcm)).toBeGreaterThanOrEqual(0);
      expect(ordinaryPcm.length).toBeGreaterThan(32000);
      let captured: Promise<Buffer> | undefined;
      let triggers = 0;
      let progress = 0;
      const playback = playAudio(
        wavFromPcm(Buffer.alloc(16000 * 2 * 10)),
        playbackAbort.signal,
        () => {
          progress++;
        },
        {
          outputTarget: `${prefix}.speaker`,
          runtimeDirectory: directory,
        },
      );
      // Attach rejection handling before firing the interrupt.
      const ended = playback.catch((error: unknown) => {
        if (!playbackAbort.signal.aborted) throw error;
      });
      playbackCleanup = ended;
      await expect.poll(() => progress, { timeout: 3000 }).toBeGreaterThan(0);
      const unwatch = session.watchBarge(new AbortController().signal, () => {
        triggers++;
        playbackAbort.abort();
        captured = ended.then(() => {
          if (!session) throw new Error("缺少会话");
          return session.capture(new AbortController().signal, () => {}).result;
        });
      });
      await playInput();
      await expect.poll(() => triggers, { timeout: 3000 }).toBe(1);
      if (!captured) throw new Error("缺少录音");
      const interrupted = readWav(await captured);
      expect(interrupted.duration).toBeGreaterThan(0.8);
      expect(Buffer.concat(rawPackets).indexOf(interrupted.pcm)).toBeGreaterThanOrEqual(0);
      const diagnostic = session.diagnostics?.();
      expect(diagnostic?.input).toBe("raw");
      for (const lane of ["raw", "clean", "reference"] as const) {
        const stream = diagnostic?.streams[lane];
        expect(stream?.packets).toBeGreaterThan(0);
        expect(stream?.sequenceGaps).toBe(0);
        expect(stream?.corrupted).toBe(0);
        expect(stream?.latest?.graph?.rate).toBeGreaterThan(0);
      }
      await expect(playback).rejects.toThrow();
      unwatch();
      const configFile = join(directory, "voice.json");
      await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
      const diagnosticDirectory = join(directory, "diagnostics");
      await exec(
        process.execPath,
        [
          "--import",
          "tsx",
          "apps/tools/src/aec-session-smoke.ts",
          "--confirm-microphone",
          "--config",
          configFile,
          "--directory",
          diagnosticDirectory,
          "--seconds",
          "3",
        ],
        { timeout: 10000 },
      );
      const report = JSON.parse(await readFile(join(diagnosticDirectory, "report.json"), "utf8"));
      expect(report.failure).toBeNull();
      expect(report.laneSeconds.raw).toBeGreaterThanOrEqual(3);
      expect(report.snapshots.at(-1).input).toBe("raw");
      expect((await stat(join(diagnosticDirectory, "raw.wav"))).mode & 0o777).toBe(0o600);
      const stats = (await readFile(join(diagnosticDirectory, "aec-statistics.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(stats.length).toBeGreaterThanOrEqual(3);
      expect(stats[0].monotonicMs).toBeGreaterThan(report.startedMonotonicMs);
      // Stop consuming native stdout: backpressure must terminate capture, not silently drop PCM.
      const cleanName = own.find((n) => String(n.info?.props?.["node.name"]).endsWith(".source"))?.info?.props?.[
        "node.name"
      ];
      if (typeof cleanName !== "string") throw new Error("缺少虚拟 AEC source");
      const stalled = spawn(
        join(pkg, "bin/voidmaker-audio-capture"),
        [`${prefix}.mic`, cleanName, `${prefix}.speaker`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stalledError = "";
      let stalledCode: number | null | undefined;
      stalled.stderr.on("data", (value: Buffer) => {
        stalledError += value.toString();
      });
      const stalledDone = new Promise<void>((resolve) =>
        stalled.once("close", (code) => {
          stalledCode = code;
          resolve();
        }),
      );
      children.push({ child: stalled, done: stalledDone });
      await expect.poll(() => stalled.exitCode, { timeout: 7000 }).toBe(1);
      stalled.stdout.resume(); // allow Node's close event to drain the already buffered bytes
      await stalledDone;
      expect(stalledCode).toBe(1);
      expect(stalledError).toContain("queue overflow");
      const waiting = session.capture(new AbortController().signal, () => {}).result;
      const rejected = expect(waiting).rejects.toThrow(/输出设备已断开|defined target not found|target disconnected/);
      speaker.kill("SIGTERM");
      await rejected;
      expect(session.signal.aborted).toBe(true);
      await session.close();
      await expect
        .poll(
          async () =>
            (await graph()).filter(
              (n) =>
                ownIds.has(n.id) &&
                n.info?.props?.["node.name"] === own.find((old) => old.id === n.id)?.info?.props?.["node.name"],
            ).length,
          { timeout: 3000 },
        )
        .toBe(0);
    } finally {
      playbackAbort.abort();
      await playbackCleanup?.catch(() => undefined);
      await session?.close();
      for (const { child } of children) child.kill("SIGTERM");
      const kill = setTimeout(() => {
        for (const { child } of children) child.kill("SIGKILL");
      }, 1000);
      await Promise.all(children.map(({ done }) => done));
      clearTimeout(kill);
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
