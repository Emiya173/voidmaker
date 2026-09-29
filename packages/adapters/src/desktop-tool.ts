import { z } from "zod";
import type { DesktopContext } from "../../contracts/src/desktop.js";
import { contextPrompt } from "../../domain/src/desktop.js";
import type { CodexTool } from "./codex.js";

export const desktopToolProfile = "desktop-tools-v1";
export function desktopTool(read: (screenshot: boolean, signal: AbortSignal) => Promise<DesktopContext>): CodexTool {
  return {
    name: "read_desktop",
    description:
      "读取用户已授权的当前桌面信息。用户问正在看什么、屏幕/游戏/视频/页面上有什么时先调用，includeScreenshot=true 获取当前聚焦显示器截图；仅需窗口标题或媒体信息时用 false。无授权、锁屏或排除应用时会返回明确错误。不要凭历史消息猜测当前画面。",
    inputSchema: {
      type: "object",
      properties: { includeScreenshot: { type: "boolean" } },
      required: ["includeScreenshot"],
      additionalProperties: false,
    },
    call: async (args, signal) => {
      const { includeScreenshot } = z.object({ includeScreenshot: z.boolean() }).strict().parse(args);
      signal.throwIfAborted();
      const data = await read(includeScreenshot, signal);
      signal.throwIfAborted();
      data.signal.throwIfAborted();
      return {
        success: true,
        contentItems: [
          { type: "inputText", text: contextPrompt("这是本次读取的桌面信息。", data.context) },
          ...(data.imageUrl ? [{ type: "inputImage" as const, imageUrl: data.imageUrl }] : []),
        ],
      };
    },
  };
}
