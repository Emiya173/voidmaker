import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { readWav, rms, wavFromPcm } from "../../../packages/adapters/src/pcm.js";
import { monitorReferenceGain, pipeWireGraphSchema } from "../../../packages/adapters/src/pipewire-graph.js";
import { aecArguments, aecSettingsSchema } from "../../../packages/contracts/src/aec.js";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    sink: { type: "string" },
    reference: { type: "string" },
    directory: { type: "string" },
    mode: { type: "string", default: "echo" },
    "reference-mode": { type: "string", default: "sink" },
    "debug-audio": { type: "boolean", default: false },
    "plugin-directory": { type: "string" },
    settings: { type: "string", default: "{}" },
    "confirm-microphone": { type: "boolean", default: false },
  },
});
if (
  !values["confirm-microphone"] ||
  !values.input ||
  !values.sink ||
  !values.reference ||
  !values.directory ||
  !["echo", "near", "double"].includes(values.mode) ||
  !["sink", "monitor"].includes(values["reference-mode"])
)
  throw new Error(
    "仅供有人值守验收：--confirm-microphone --input NODE --sink NODE --reference WAV --directory NEW_DIR --mode echo|near|double",
  );
const directory = resolve(values.directory);
const settings = aecSettingsSchema.parse(JSON.parse(values.settings));
if (!values["plugin-directory"] && values.settings !== "{}") throw new Error("AEC3 参数需要指定定制插件目录");
process.umask(0o077);
const reference = resolve(values.reference);
const audio = readWav(await readFile(reference));
if (audio.duration < 5 || audio.duration > 25) throw new Error("参考播报需为 5–25 秒 PCM WAV");
await mkdir(directory, { mode: 0o700 });
const duration = Math.ceil(audio.duration + 4);
const rate = 16000;
const abort = new AbortController();
const deadline = AbortSignal.any([abort.signal, AbortSignal.timeout((duration + 20) * 1000)]);
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
const children: { child: ChildProcess; done: Promise<void> }[] = [];
const name = `voidmaker-aec-test-${process.pid}`;
const exec = promisify(execFile);
async function graph() {
  const { stdout } = await exec("pw-dump", [], { signal: deadline, maxBuffer: 8 * 1024 * 1024 });
  return pipeWireGraphSchema.parse(JSON.parse(stdout));
}
const monitorMode = values["reference-mode"] === "monitor";
const initialGraph = await graph();
const input = initialGraph.find((node) => node.info?.props?.["node.name"] === values.input);
const sink = initialGraph.find((node) => node.info?.props?.["node.name"] === values.sink);
if (input?.info?.props?.["media.class"] !== "Audio/Source" || sink?.info?.props?.["media.class"] !== "Audio/Sink")
  throw new Error("需要存在的麦克风 source 和扬声器 sink node.name，禁止回退至默认设备");
const referenceGain = monitorMode ? monitorReferenceGain(sink) : 1;
function launch(executable: string, args: string[], onData?: (chunk: Buffer) => void, completeSamples?: () => boolean) {
  deadline.throwIfAborted();
  const child = spawn(executable, args, { stdio: ["pipe", onData ? "pipe" : "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.stdout?.on("data", onData ?? (() => undefined));
  const done = new Promise<void>((ok, fail) => {
    child.once("error", fail);
    child.once("close", (code, signal) =>
      // PipeWire 1.6.6 sample-count completion does not set its drained flag and exits 1.
      // Accept that case only with every requested PCM sample present and no diagnostic.
      code === 0 || (code === 1 && !stderr.trim() && completeSamples?.())
        ? ok()
        : fail(new Error(`${executable} 退出 ${code ?? signal}: ${stderr}`)),
    );
  });
  void done.catch(() => undefined);
  children.push({ child, done });
  return { child, done };
}
async function cleanup() {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1000);
  try {
    await Promise.allSettled(children.map((item) => item.done));
  } finally {
    clearTimeout(timer);
  }
}
let killTimer: NodeJS.Timeout | undefined;
const stop = () => {
  for (const { child } of children) child.kill("SIGTERM");
  killTimer = setTimeout(() => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1000);
};
deadline.addEventListener("abort", stop, { once: true });
try {
  console.log(
    `${input.info.props["node.virtual"] === true ? "虚拟音频" : "麦克风"}测试开始：将同时保存原始和 AEC 录音，结束后自动卸载临时节点。`,
  );
  const module = launch(
    values["plugin-directory"] ? join(resolve(values["plugin-directory"]), "../../bin/voidmaker-aec-pw-cli") : "pw-cli",
    [
      "--monitor",
      "load-module",
      "libpipewire-module-echo-cancel",
      JSON.stringify({
        "library.name": values["plugin-directory"] ? "aec/libspa-aec-voidmaker" : "aec/libspa-aec-webrtc",
        "audio.rate": 48000,
        "audio.channels": 1,
        "audio.position": ["MONO"],
        "node.latency": "480/48000",
        "monitor.mode": monitorMode,
        "aec.args": {
          ...aecArguments(settings),
          ...(values["plugin-directory"] && values["debug-audio"]
            ? {
                "webrtc.aec3.linear-dump": join(directory, "linear.f32"),
                "webrtc.aec3.stats-dump": join(directory, "statistics.jsonl"),
              }
            : {}),
        },
        "capture.props": {
          "node.name": `${name}.capture`,
          "target.object": values.input,
          "node.passive": true,
          "node.dont-fallback": true,
          "node.dont-reconnect": true,
        },
        "playback.props": {
          "node.name": `${name}.playback`,
          "target.object": values.sink,
          "node.passive": true,
          "node.dont-fallback": true,
          "node.dont-reconnect": true,
        },
        "source.props": {
          "node.name": `${name}.source`,
          "node.description": "VoidMaker AEC test input",
          "priority.session": 0,
          "state.restore-props": false,
        },
        "sink.props": {
          "node.name": `${name}.sink`,
          "node.description": "VoidMaker AEC test output",
          "priority.session": 0,
          "state.restore-props": false,
          ...(monitorMode
            ? {
                "target.object": values.sink,
                "node.dont-fallback": true,
                "node.dont-reconnect": true,
                "node.param.Props": { volume: referenceGain },
              }
            : {}),
        },
      }),
    ],
  );
  let ready = false;
  for (let i = 0; i < 40; i++) {
    deadline.throwIfAborted();
    if (module.child.exitCode !== null || module.child.signalCode !== null) await module.done;
    const nodes = await graph();
    const capture = nodes.find((node) => node.info?.props?.["node.name"] === `${name}.capture`);
    if (capture && nodes.some((node) => node.info?.props?.["node.name"] === `${name}.source`)) {
      if (values["debug-audio"])
        await exec(
          "pw-cli",
          [
            "set-param",
            String(capture.id),
            "Props",
            JSON.stringify({
              params: ["debug.aec.wav-path", join(directory, "internal.wav")],
            }),
          ],
          { signal: deadline },
        );
      ready = true;
      break;
    }
    await delay(100, undefined, { signal: deadline });
  }
  if (!ready) throw new Error("临时 AEC 节点未就绪");
  function record(target: string) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const capture = launch(
      "pw-record",
      [
        "--raw",
        "--format",
        "s16",
        "--rate",
        String(rate),
        "--channels",
        "1",
        "--latency",
        "20ms",
        "--properties",
        JSON.stringify({ "node.dont-fallback": true, "node.dont-reconnect": true }),
        "--sample-count",
        String(duration * rate),
        "--target",
        target,
        "-",
      ],
      (chunk) => {
        bytes += chunk.length;
        if (bytes > (duration + 1) * rate * 2) abort.abort();
        else chunks.push(chunk);
      },
      () => bytes === duration * rate * 2,
    );
    return { done: capture.done, pcm: () => Buffer.concat(chunks) };
  }
  const raw = record(values.input);
  const clean = record(`${name}.source`);
  await delay(1000, undefined, { signal: deadline });
  const playback =
    values.mode === "near"
      ? null
      : launch("pw-play", [
          "--properties",
          JSON.stringify({ "node.dont-fallback": true, "node.dont-reconnect": true }),
          "--target",
          monitorMode ? values.sink : `${name}.sink`,
          reference,
        ]);
  if (values["debug-audio"])
    await writeFile(join(directory, "graph.json"), JSON.stringify(await graph(), null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ phase: "recording", mode: values.mode, seconds: duration, playback: !!playback }));
  await Promise.all([raw.done, clean.done, playback?.done]);
  deadline.throwIfAborted();
  const finalSink = (await graph()).find((node) => node.id === sink.id);
  const referenceVolumeStable =
    !monitorMode || (finalSink !== undefined && monitorReferenceGain(finalSink) === referenceGain);
  const original = raw.pcm();
  const processed = clean.pcm();
  if (original.length !== duration * rate * 2 || processed.length !== duration * rate * 2)
    throw new Error("录音样本数与请求时长不符");
  await writeFile(join(directory, "raw.wav"), wavFromPcm(original), { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "aec.wav"), wavFromPcm(processed), { mode: 0o600, flag: "wx" });
  const segment = (pcm: Buffer) =>
    pcm.subarray(4 * rate * 2, Math.min(pcm.length, Math.floor(audio.duration * rate) * 2));
  const rawRms = rms(segment(original));
  const cleanRms = rms(segment(processed));
  const report = {
    mode: values.mode,
    referenceMode: values["reference-mode"],
    referenceGain,
    settings,
    pluginDirectory: values["plugin-directory"] ?? null,
    referenceVolumeStable,
    recordedAt: new Date().toISOString(),
    duration,
    rawSeconds: original.length / (rate * 2),
    aecSeconds: processed.length / (rate * 2),
    window: { startSeconds: 4, endSeconds: audio.duration },
    rawRms,
    aecRms: cleanRms,
    attenuationDb: rawRms && cleanRms ? 20 * Math.log10(rawRms / cleanRms) : null,
    note: "同一次录音两路能量比较，未校准群延迟；仅无人说话的纯回声场景可解释为回声衰减。此工具不实现助手插话。",
  };
  await writeFile(join(directory, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
  if (!referenceVolumeStable) throw new Error("测试期间输出音量发生变化，本轮参考增益无效，录音仅用于诊断");
} finally {
  deadline.removeEventListener("abort", stop);
  await cleanup();
  if (values["debug-audio"])
    await chmod(join(directory, "internal.wav"), 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  clearTimeout(killTimer);
  console.log("麦克风测试已停止，临时 AEC 节点已释放。");
}
