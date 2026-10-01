import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { serveVoiceReview } from "../apps/tools/src/voice-review-server.js";
import { wavFromPcm } from "../packages/adapters/src/pcm.js";
import { openVoiceReview } from "../packages/adapters/src/voice-review-store.js";

it.skipIf(process.env.VOIDMAKER_REVIEW_BROWSER !== "1")(
  "opens a cross-site link, edits, confirms, reloads and handles conflicts in Chromium without playing audio",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "voidmaker-review-browser-"));
    const wav = wavFromPcm(Buffer.alloc(96000));
    const audio = join(root, "original.wav"),
      dataset = join(root, "dataset.jsonl");
    const source = {
      file: "original.wav",
      audio,
      duration_seconds: 3,
      source_sha256: createHash("sha256").update(wav).digest("hex"),
      text_ja: "元の台詞。",
      text_zh: "原始台词",
      emotion: "平静",
      delivery: "自然平缓",
      speech_act: "陈述",
      confidence: "中",
      reason: "语义估计",
      needs_review: true,
      review_reason: "待听音",
      reviewed: false,
    };
    await writeFile(audio, wav);
    await writeFile(dataset, ["one", "two"].map((id) => JSON.stringify({ ...source, id })).join("\n"));
    const store = await openVoiceReview(dataset),
      server = await serveVoiceReview(store, 0);
    const landing = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<a id="review-link" href="${server.url}">打开语料校验</a>`);
    });
    landing.listen(0, "127.0.0.1");
    await once(landing, "listening");
    const address = landing.address();
    if (!address || typeof address === "string") throw new Error("Missing landing page port");
    const child = spawn(
      process.env.VOIDMAKER_CHROMIUM ?? "chromium",
      [
        "--headless",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-extensions",
        "--no-first-run",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${root}/browser`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let socket: WebSocket | undefined;
    let log = "";
    child.stderr.on("data", (data) => {
      log = (log + data).slice(-4000);
    });
    try {
      let endpoint = "";
      await expect
        .poll(
          async () => {
            try {
              const [port, path] = (await readFile(join(root, "browser/DevToolsActivePort"), "utf8"))
                .trim()
                .split("\n");
              endpoint = `ws://127.0.0.1:${port}${path}`;
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 10000, message: log },
        )
        .toBe(true);
      socket = new WebSocket(endpoint);
      await once(socket, "open");
      const connected = socket;
      let serial = 0;
      type Reply = { targetId?: string; sessionId?: string; exceptionDetails?: unknown; result?: { value?: unknown } };
      const pending = new Map<number, { resolve: (value: Reply) => void; reject: (error: Error) => void }>();
      connected.addEventListener("message", (event) => {
        const r = JSON.parse(String(event.data)),
          p = pending.get(r.id);
        if (!p) return;
        pending.delete(r.id);
        r.error ? p.reject(new Error(JSON.stringify(r.error))) : p.resolve(r.result);
      });
      const call = (method: string, params: unknown = {}, sessionId?: string): Promise<Reply> =>
        new Promise((resolve, reject) => {
          const id = ++serial;
          pending.set(id, { resolve, reject });
          connected.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      const { targetId } = await call("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
      const send = (method: string, params: unknown = {}) => call(method, params, sessionId);
      const evaluate = async (expression: string) => {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result?.value;
      };
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Page.navigate", { url: `http://localhost:${address.port}` });
      await expect.poll(() => evaluate("!!document.getElementById('review-link')")).toBe(true);
      await evaluate("document.getElementById('review-link').click()");
      await expect.poll(() => evaluate("document.querySelectorAll('.sample').length")).toBe(2);
      await expect.poll(() => evaluate("document.getElementById('player').duration")).toBe(3);
      expect(await evaluate("document.getElementById('player').paused")).toBe(true);
      await evaluate(
        "document.getElementById('text_ja').value='修正した台詞。';document.getElementById('text_ja').dispatchEvent(new Event('input'));document.getElementById('save').click()",
      );
      await expect.poll(() => store.get("one").text_ja).toBe("修正した台詞。");
      expect(store.get("one").reviewed).toBe(false);
      await expect.poll(() => evaluate("document.getElementById('save').disabled")).toBe(false);
      const previousDocument = await evaluate("performance.timeOrigin");
      await send("Page.reload");
      await expect.poll(() => evaluate("performance.timeOrigin"), { timeout: 5000 }).not.toBe(previousDocument);
      await expect.poll(() => evaluate("document.getElementById('text_ja')?.value")).toBe("修正した台詞。");
      await evaluate("document.getElementById('confirm-next').click()");
      await expect
        .poll(() => evaluate("document.getElementById('row-meta').textContent"), { timeout: 5000 })
        .toContain("two");
      expect(store.get("one")).toMatchObject({ reviewed: true, needs_review: false, revision: 2 });
      await evaluate(
        "document.getElementById('text_zh').value='不能丢失的未保存修改';document.getElementById('text_zh').dispatchEvent(new Event('input'))",
      );
      await evaluate(
        "window.confirm=()=>false;document.getElementById('status').value='all';document.getElementById('status').dispatchEvent(new Event('input'));document.getElementById('previous').click()",
      );
      expect(await evaluate("document.getElementById('text_zh').value")).toBe("不能丢失的未保存修改");
      const latest = store.get("two");
      const otherFields = {
        text_ja: latest.text_ja,
        text_zh: "另一页面修正",
        emotion: latest.emotion,
        delivery: latest.delivery,
        speech_act: latest.speech_act,
        needs_review: false,
        review_reason: "",
        reviewed: true,
        excluded: false,
        review_note: "",
      };
      await store.save("two", { revision: 0, fields: otherFields });
      await evaluate("document.getElementById('save').click()");
      await expect.poll(() => evaluate("document.getElementById('notice').textContent")).toContain("另一页面");
      expect(await evaluate("document.getElementById('text_zh').value")).toBe("不能丢失的未保存修改");
      expect(store.get("two").text_zh).toBe("另一页面修正");
      expect(await evaluate("document.getElementById('player').paused")).toBe(true);
      await evaluate("window.confirm=()=>true;document.getElementById('reload').click()");
      await expect.poll(() => evaluate("document.getElementById('text_zh').value")).toBe("另一页面修正");
      expect(await fetch(`${server.url}/api/export?format=jsonl&reviewed=1`).then((r) => r.text())).toContain(
        "修正した台詞。",
      );
    } finally {
      socket?.close();
      if (child.exitCode === null) {
        const done = once(child, "close");
        child.kill("SIGTERM");
        await done;
      }
      await server.close();
      await new Promise<void>((resolve) => landing.close(() => resolve()));
      await store.close();
      await delay(50);
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
