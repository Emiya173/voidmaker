import { createHash, randomUUID } from "node:crypto";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  type ReviewChange,
  type ReviewRow,
  type ReviewSave,
  reviewSample,
  reviewSave,
  reviewState,
} from "../../contracts/src/voice-review.js";
import { boundedFile } from "./character-assets.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export async function openVoiceReview(dataset: string) {
  const path = await realpath(dataset);
  const root = dirname(path);
  const statePath = join(root, "review-state.json");
  const lockPath = join(root, "review-state.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => {
    throw new Error(`此数据集已被校验工具打开；若上次进程异常退出，请确认进程已结束后移除 ${lockPath}`);
  });
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  await lock.close();
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  try {
    const source = await boundedFile(path, 32 * 1024 * 1024);
    const fingerprint = hash(source);
    const samples = source
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => reviewSample.parse(JSON.parse(line)));
    if (!samples.length || new Set(samples.map((s) => s.id)).size !== samples.length)
      throw new Error("数据集为空或存在重复编号");
    if (samples.some((s) => !isAbsolute(s.audio))) throw new Error("音频路径须为绝对路径");
    const originals = new Map(samples.map((sample) => [sample.id, sample]));
    let changes: ReviewChange[] = [];
    try {
      const state = reviewState.parse(JSON.parse((await boundedFile(statePath, 64 * 1024 * 1024)).toString("utf8")));
      if (state.dataset_sha256 !== fingerprint) throw new Error("原始数据集已变更，不能将旧修正套用到不同数据");
      changes = state.changes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const latest = new Map<string, ReviewChange>();
    for (const change of changes) {
      if (!originals.has(change.id) || change.revision !== (latest.get(change.id)?.revision ?? 0) + 1)
        throw new Error("校验记录编号或版本不一致");
      reviewSave.parse({ revision: change.revision - 1, fields: change.fields });
      latest.set(change.id, change);
    }
    const row = (id: string): ReviewRow => {
      const original = originals.get(id);
      if (!original) throw new Error("素材不存在");
      const edit = latest.get(id);
      return {
        ...original,
        excluded: false,
        review_note: "",
        ...edit?.fields,
        revision: edit?.revision ?? 0,
        updated_at: edit?.updated_at ?? null,
        original,
      };
    };
    return {
      name: root.split("/").at(-1) ?? "语音校验",
      list: () => samples.map((sample) => row(sample.id)),
      get: row,
      save(id: string, request: ReviewSave): Promise<ReviewRow | null> {
        if (closed) return Promise.reject(new Error("校验工具已关闭"));
        const result = queue.then(async () => {
          const data = reviewSave.parse(request);
          if (row(id).revision !== data.revision) return null;
          const change: ReviewChange = {
            id,
            revision: data.revision + 1,
            updated_at: new Date().toISOString(),
            fields: data.fields,
          };
          const next = [...changes, change];
          const temp = join(root, `.review-${randomUUID()}.tmp`);
          try {
            const file = await open(temp, "wx", 0o600);
            try {
              await file.writeFile(`${JSON.stringify({ version: 1, dataset_sha256: fingerprint, changes: next })}\n`);
              await file.sync();
            } finally {
              await file.close();
            }
            await rename(temp, statePath);
          } finally {
            await unlink(temp).catch(() => undefined);
          }
          changes = next;
          latest.set(id, change);
          return row(id);
        });
        queue = result.catch(() => undefined);
        return result;
      },
      async audio(id: string): Promise<Buffer> {
        const sample = row(id);
        const audio = await boundedFile(await realpath(sample.audio), 32 * 1024 * 1024);
        if (hash(audio) !== sample.source_sha256) throw new Error("原始音频已变更，暂停试听以避免校验错配");
        return audio;
      },
      async close() {
        if (closed) return;
        closed = true;
        await queue;
        await unlink(lockPath);
      },
    };
  } catch (error) {
    await unlink(lockPath);
    throw error;
  }
}
export type VoiceReviewStore = Awaited<ReturnType<typeof openVoiceReview>>;

export function exportReview(rows: readonly ReviewRow[], format: "csv" | "jsonl"): string {
  const values = rows.map((row) => ({
    ...row,
    basis: row.reviewed ? "human_reviewed" : row.revision ? "human_edited_pending_review" : row.original.basis,
  }));
  if (format === "jsonl") return values.length ? `${values.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
  const fields = [
    "id",
    "file",
    "duration_seconds",
    "text_ja",
    "text_zh",
    "emotion",
    "delivery",
    "speech_act",
    "reviewed",
    "excluded",
    "review_note",
    "needs_review",
    "review_reason",
    "revision",
    "updated_at",
    "audio",
    "basis",
    "original_text_ja",
  ] as const;
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    // Spreadsheet imports must not interpret a corrected line as a formula.
    return `"${(/^[=+@\-\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
  };
  return (
    "\ufeff" +
    [
      fields.join(","),
      ...values.map((row) =>
        fields.map((key) => cell(key === "original_text_ja" ? row.original.text_ja : row[key])).join(","),
      ),
    ].join("\r\n") +
    "\r\n"
  );
}
