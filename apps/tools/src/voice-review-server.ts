import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exportReview, type VoiceReviewStore } from "../../../packages/adapters/src/voice-review-store.js";
import { reviewOptions, reviewSave } from "../../../packages/contracts/src/voice-review.js";
import { voiceReviewPage } from "./voice-review-page.js";

export async function serveVoiceReview(store: VoiceReviewStore, port = 8766) {
  const token = randomBytes(32).toString("hex");
  let origin = "";
  let closing: Promise<void> | undefined;
  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const url = new URL(req.url ?? "/", origin);
    // A link may navigate here from another site; only the public HTML entry is exempt.
    const homeNavigation =
      req.method === "GET" &&
      url.pathname === "/" &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] === "cross-site" && !homeNavigation)
    ) {
      json(res, 403, { error: "仅允许从本地校验页面访问" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(voiceReviewPage);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dataset") {
      json(res, 200, { name: store.name, rows: store.list(), options: reviewOptions, token });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/export") {
      const format = url.searchParams.get("format") === "jsonl" ? "jsonl" : "csv";
      const reviewed = url.searchParams.get("reviewed") === "1";
      const rows = store.list().filter((row) => !reviewed || (row.reviewed && !row.excluded));
      res.writeHead(200, {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="voice-${reviewed ? "confirmed" : "corrected"}.${format}"`,
      });
      res.end(exportReview(rows, format));
      return;
    }
    const edit = /^\/api\/rows\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (edit?.[1] && req.method === "PUT") {
      if (req.headers["x-review-token"] !== token || !req.headers["content-type"]?.startsWith("application/json")) {
        json(res, 403, { error: "页面授权已过期，请刷新后再保存" });
        return;
      }
      if (!store.list().some((row) => row.id === edit[1])) {
        json(res, 404, { error: "素材不存在" });
        return;
      }
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 64 * 1024) {
          json(res, 413, { error: "修改内容过长" });
          return;
        }
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        json(res, 400, { error: "无效 JSON" });
        return;
      }
      const parsed = reviewSave.safeParse(value);
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? "字段无效" });
        return;
      }
      const row = await store.save(edit[1], parsed.data);
      if (!row) json(res, 409, { error: "另一页面已保存新版本。请重新载入该条，再合并你的修改。" });
      else json(res, 200, { row });
      return;
    }
    const audio = /^\/audio\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (audio?.[1] && ["GET", "HEAD"].includes(req.method ?? "")) {
      if (!store.list().some((row) => row.id === audio[1])) {
        json(res, 404, { error: "素材不存在" });
        return;
      }
      const wav = await store.audio(audio[1]);
      const range = req.headers.range;
      let start = 0,
        end = wav.length - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, wav.length - Number(match[2]));
          end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
        } else start = wav.length;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= wav.length) {
          res.writeHead(416, { "Content-Range": `bytes */${wav.length}` });
          res.end();
          return;
        }
        res.setHeader("Content-Range", `bytes ${start}-${end}/${wav.length}`);
      }
      res.writeHead(range ? 206 : 200, {
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      res.end(req.method === "HEAD" ? undefined : wav.subarray(start, end + 1));
      return;
    }
    json(res, 404, { error: "页面不存在" });
  }
  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, 503, { error: error instanceof Error ? error.message : "保存失败，请重试" });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法监听本地端口");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        // A stalled browser request must not keep the process and dataset lock alive on exit.
        const timeout = setTimeout(() => server.closeAllConnections(), 2000);
        timeout.unref();
        server.close((error) => (error ? reject(error) : resolve()));
        server.once("close", () => clearTimeout(timeout));
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
