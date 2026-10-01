import { parseArgs } from "node:util";
import { openVoiceReview } from "../../../packages/adapters/src/voice-review-store.js";
import { serveVoiceReview } from "./voice-review-server.js";

const { values } = parseArgs({ options: { dataset: { type: "string" }, port: { type: "string", default: "8766" } } });
const port = Number(values.port);
if (!values.dataset || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("用法: pnpm voice:review --dataset /path/dataset.jsonl [--port 8766]");
const store = await openVoiceReview(values.dataset);
try {
  const server = await serveVoiceReview(store, port);
  console.log(`语音人工校验: ${server.url}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    await store.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
} catch (error) {
  await store.close();
  throw error;
}
