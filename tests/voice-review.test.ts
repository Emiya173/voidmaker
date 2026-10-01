import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { serveVoiceReview } from "../apps/tools/src/voice-review-server.js";
import { wavFromPcm } from "../packages/adapters/src/pcm.js";
import { exportReview, openVoiceReview } from "../packages/adapters/src/voice-review-store.js";
import type { ReviewFields } from "../packages/contracts/src/voice-review.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fields: ReviewFields = {
  text_ja: "いいと思う。",
  text_zh: "我觉得可以。",
  emotion: "平静",
  delivery: "自然平缓",
  speech_act: "赞同",
  needs_review: false,
  review_reason: "",
  reviewed: true,
  excluded: false,
  review_note: "听音核对",
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "voidmaker-review-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const wav = wavFromPcm(Buffer.alloc(96000));
  const sample = {
    ...fields,
    id: "sample_1",
    file: "original#1.wav",
    audio: join(root, "original#1.wav"),
    duration_seconds: 3,
    source_sha256: createHash("sha256").update(wav).digest("hex"),
    text_ja: "自動転写。",
    reviewed: false,
    confidence: "中",
    reason: "语义估计",
    basis: "transcript_semantics_only",
  };
  const path = join(root, "dataset.jsonl"),
    source = `${JSON.stringify(sample)}\n`;
  await writeFile(path, source);
  await writeFile(sample.audio, wav);
  const store = await openVoiceReview(path);
  cleanup.push(() => store.close());
  return { root, path, source, sample, wav, store };
}
it("persists corrections and revision history across restart without changing originals", async () => {
  const f = await fixture();
  await f.store.save("sample_1", { revision: 0, fields });
  await f.store.save("sample_1", { revision: 1, fields: { ...fields, text_zh: "修正中文" } });
  expect(await readFile(f.path, "utf8")).toBe(f.source);
  await f.store.close();
  const reopened = await openVoiceReview(f.path);
  cleanup.push(() => reopened.close());
  expect(reopened.get("sample_1")).toMatchObject({
    text_zh: "修正中文",
    reviewed: true,
    revision: 2,
    original: { text_ja: "自動転写。", reviewed: false },
  });
  const state = JSON.parse(await readFile(join(f.root, "review-state.json"), "utf8"));
  expect(state.changes.map((r: { fields: ReviewFields }) => r.fields.text_zh)).toEqual(["我觉得可以。", "修正中文"]);
  expect(await reopened.audio("sample_1")).toEqual(f.wav);
  expect(JSON.parse(exportReview(reopened.list(), "jsonl")).basis).toBe("human_reviewed");
});
it("serializes saves, rejects stale revisions, and keeps the previous state when writing fails", async () => {
  const f = await fixture();
  const results = await Promise.all([
    f.store.save("sample_1", { revision: 0, fields }),
    f.store.save("sample_1", { revision: 0, fields: { ...fields, text_ja: "別の修正" } }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(f.store.get("sample_1").revision).toBe(1);
  await f.store.close();
  await rm(join(f.root, "review-state.json"));
  const reopened = await openVoiceReview(f.path);
  cleanup.push(() => reopened.close());
  await mkdir(join(f.root, "review-state.json"));
  await expect(reopened.save("sample_1", { revision: 0, fields })).rejects.toThrow();
  expect(reopened.get("sample_1").revision).toBe(0);
  await rm(join(f.root, "review-state.json"), { recursive: true });
  await expect(reopened.save("sample_1", { revision: 0, fields })).resolves.toMatchObject({ revision: 1 });
});
it("prevents duplicate writers, invalid edits and applying corrections to changed source files", async () => {
  const f = await fixture();
  await expect(openVoiceReview(f.path)).rejects.toThrow("已被");
  await expect(f.store.save("sample_1", { revision: 0, fields: { ...fields, needs_review: true } })).rejects.toThrow();
  await expect(f.store.save("sample_1", { revision: 0, fields: { ...fields, text_ja: "" } })).rejects.toThrow();
  await f.store.save("sample_1", { revision: 0, fields });
  await writeFile(f.sample.audio, Buffer.from("changed"));
  await expect(f.store.audio("sample_1")).rejects.toThrow("原始音频已变更");
  await f.store.close();
  await writeFile(f.path, f.source.replace("自動転写。", "Changed"));
  await expect(openVoiceReview(f.path)).rejects.toThrow("原始数据集已变更");
});
it("serves range audio, protects mutations and exports only confirmed usable samples on request", async () => {
  const f = await fixture(),
    server = await serveVoiceReview(f.store, 0);
  cleanup.push(() => server.close());
  const data = await fetch(`${server.url}/api/dataset`).then((r) => r.json());
  const save = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.url}/api/rows/sample_1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Review-Token": data.token, ...headers },
      body: JSON.stringify(body),
    });
  const body = { revision: 0, fields };
  expect((await save(body, { "X-Review-Token": "wrong" })).status).toBe(403);
  expect((await save(body, { Origin: "http://example.com" })).status).toBe(403);
  const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${server.url}/api/dataset`, { headers: { Host: "example.com" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  expect(invalidHost).toBe(403);
  expect((await save({ ...body, fields: { ...fields, audio: "/etc/passwd" } })).status).toBe(400);
  expect((await save(body)).status).toBe(200);
  expect((await save(body)).status).toBe(409);
  const partial = await fetch(`${server.url}/audio/sample_1`, { headers: { Range: "bytes=0-43" } });
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe(`bytes 0-43/${f.wav.length}`);
  expect(Buffer.from(await partial.arrayBuffer())).toEqual(f.wav.subarray(0, 44));
  expect((await fetch(`${server.url}/audio/sample_1`, { headers: { Range: "bytes=999999999-" } })).status).toBe(416);
  expect((await fetch(`${server.url}/audio/unknown`)).status).toBe(404);
  expect(await fetch(`${server.url}/api/export?format=jsonl&reviewed=1`).then((r) => r.text())).toContain(
    "human_reviewed",
  );
  await save({ revision: 1, fields: { ...fields, excluded: true } });
  expect(await fetch(`${server.url}/api/export?format=jsonl&reviewed=1`).then((r) => r.text())).toBe("");
  expect(await fetch(`${server.url}/api/export?format=csv`).then((r) => r.text())).toContain("original_text_ja");
});

it("allows a cross-site navigation to the review page while keeping data and edits same-origin", async () => {
  const f = await fixture(),
    server = await serveVoiceReview(f.store, 0);
  cleanup.push(() => server.close());
  const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${server.url}${path}`, { method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  const navigation = {
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };
  expect(await request("/", navigation)).toBe(200);
  expect(await request("/")).toBe(200);
  expect(await request("/", { ...navigation, "Sec-Fetch-Dest": "iframe" })).toBe(403);
  expect(await request("/", { ...navigation, "Sec-Fetch-Mode": "cors" })).toBe(403);
  expect(await request("/", { ...navigation, Host: "example.com" })).toBe(403);
  expect(await request("/", { ...navigation, Origin: "http://example.com" })).toBe(403);
  for (const path of ["/api/dataset", "/api/export", "/audio/sample_1"])
    expect(await request(path, navigation)).toBe(403);
  expect(await request("/api/rows/sample_1", navigation, "PUT")).toBe(403);
  expect(f.store.get("sample_1").revision).toBe(0);
});

it("closes stalled requests so the dataset lock can be released and the service restarted", async () => {
  const f = await fixture(),
    server = await serveVoiceReview(f.store, 0);
  cleanup.push(() => server.close());
  const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(server.url).port) });
  socket.on("error", () => undefined);
  cleanup.push(async () => socket.destroy());
  await once(socket, "connect");
  const { token } = await fetch(`${server.url}/api/dataset`).then((r) => r.json());
  const headers = [
    "PUT /api/rows/sample_1 HTTP/1.1",
    `Host: ${new URL(server.url).host}`,
    "Content-Type: application/json",
    `X-Review-Token: ${token}`,
    "Content-Length: 100",
    "",
    "{",
  ].join("\r\n");
  await new Promise<void>((resolve) => socket.write(headers, () => resolve()));
  await server.close();
  expect(f.store.get("sample_1").revision).toBe(0);
  await f.store.close();
  const reopened = await openVoiceReview(f.path);
  cleanup.push(() => reopened.close());
  expect(reopened.get("sample_1").revision).toBe(0);
}, 5000);
