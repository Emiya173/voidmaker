import { z } from "zod";
import { contextPrompt } from "../../domain/src/desktop.js";
import { CodexAppServer, type CodexOptions } from "./codex.js";

const suggestionSchema = z.object({ speak: z.boolean(), text: z.string().max(2000) });

export async function suggestDesktop(
  cwd: string,
  context: string,
  signal: AbortSignal,
  options: CodexOptions = {},
): Promise<string> {
  const bound = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  bound.throwIfAborted();
  const client = new CodexAppServer(async () => "decline", cwd, "codex", ["app-server", "--stdio"], {
    ...options,
    restricted: true,
    observer: true,
  });
  const cancel = () => {
    void client.close();
  };
  bound.addEventListener("abort", cancel, { once: true });
  try {
    await client.start();
    bound.throwIfAborted();
    const thread = await client.startThread();
    bound.throwIfAborted();
    const result = await client.run(thread, contextPrompt("判断是否需要一条桌面建议。", context), () => undefined);
    bound.throwIfAborted();
    const parsed = suggestionSchema.parse(JSON.parse(result));
    return parsed.speak ? parsed.text : "";
  } finally {
    bound.removeEventListener("abort", cancel);
    await client.close();
  }
}
