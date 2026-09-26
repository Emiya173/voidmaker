import { spawn } from "node:child_process";
import { z } from "zod";
import { selectDesktopWindow } from "../../domain/src/desktop.js";

export type DesktopCommand = (
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  limit?: number,
  timeout?: number,
) => Promise<Buffer>;
/** No shell interpolation; bound output and lifetime and reap subprocesses on cancellation. */
export const desktopCommand: DesktopCommand = (executable, args, signal, limit = 64 * 1024, timeout = 5000) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let length = 0;
    let stderr = "";
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500);
    };
    const abort = () => stop(new Error("桌面读取已取消"));
    const timer = setTimeout(() => stop(new Error(`${executable} 超时`)), timeout);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      length += data.length;
      if (length > limit) stop(new Error(`${executable} 输出过大`));
      else chunks.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-1000);
    });
    child.on("error", (error) => {
      failure = new Error(`${executable} 不可用`, { cause: error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${executable} 失败: ${stderr.trim() || code}`));
      else resolve(Buffer.concat(chunks));
    });
  });
const windowSchema = z.object({
  id: z.number().int().nonnegative(),
  app_id: z.string().max(512).nullable(),
  title: z.string().max(8192).nullable(),
});
const windowsSchema = z
  .array(
    windowSchema.extend({
      is_focused: z.boolean(),
      focus_timestamp: z.object({ secs: z.int().nonnegative(), nanos: z.int().min(0).max(999_999_999) }).nullable(),
    }),
  )
  .max(512);
export type FocusedWindow = (z.infer<typeof windowSchema> & { selection: "focused" | "recent" }) | null;
export type DesktopAdapters = ReturnType<typeof desktopAdapters>;
export function desktopAdapters(run: DesktopCommand = desktopCommand) {
  return {
    async window(signal: AbortSignal): Promise<FocusedWindow> {
      const raw = await run("niri", ["msg", "--json", "focused-window"], signal);
      const focused = windowSchema.nullable().parse(JSON.parse(raw.toString()));
      if (focused) return { ...focused, selection: "focused" };
      signal.throwIfAborted();
      // Layer-shell surfaces can own keyboard focus. Select the compositor's last focused toplevel on demand.
      const snapshot = await run("niri", ["msg", "--json", "windows"], signal, 1024 * 1024);
      const selected = selectDesktopWindow(windowsSchema.parse(JSON.parse(snapshot.toString())));
      return selected
        ? {
            id: selected.id,
            app_id: selected.app_id,
            title: selected.title,
            selection: selected.is_focused ? "focused" : "recent",
          }
        : null;
    },
    async media(signal: AbortSignal): Promise<string> {
      // Listing first distinguishes no players from a broken session bus or missing executable.
      let players: string;
      try {
        players = (await run("playerctl", ["--list-all"], signal)).toString().trim();
      } catch (error) {
        if (error instanceof Error && error.message.includes("No players found")) return "当前没有媒体播放器";
        throw error;
      }
      const player = players.split("\n")[0];
      if (!player) return "当前没有媒体播放器";
      const value = (
        await run(
          "playerctl",
          ["--player", player, "metadata", "--format", "{{playerName}}\u001f{{status}}\u001f{{artist}}\u001f{{title}}"],
          signal,
        )
      )
        .toString()
        .trim();
      const parts = value.split("\u001f");
      if (parts.length !== 4) throw new Error("媒体元数据格式无效");
      const [name, status, artist, title] = parts;
      if (!["Playing", "Paused", "Stopped"].includes(status ?? "")) throw new Error("媒体状态无效");
      return `播放器：${name}\n状态：${status}\n曲目：${title?.slice(0, 2000)}\n艺人：${artist?.slice(0, 1000)}`;
    },
    async region(signal: AbortSignal): Promise<Buffer> {
      const region = (await run("slurp", ["-f", "%x,%y %wx%h"], signal, 256, 60_000)).toString().trim();
      if (!/^-?\d+,-?\d+ [1-9]\d*x[1-9]\d*$/.test(region)) throw new Error("框选已取消或区域无效");
      const png = await run("grim", ["-g", region, "-t", "png", "-"], signal, 8 * 1024 * 1024, 10_000);
      if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error("截图不是有效 PNG");
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      if (!width || !height || width * height > 32_000_000) throw new Error("截图尺寸过大或无效");
      return png;
    },
    async unlocked(signal: AbortSignal): Promise<boolean> {
      const state = (
        await run("loginctl", ["show-session", "auto", "-p", "Active", "-p", "LockedHint", "-p", "IdleHint"], signal)
      )
        .toString()
        .split("\n");
      return state.includes("Active=yes") && state.includes("LockedHint=no") && state.includes("IdleHint=no");
    },
  };
}
