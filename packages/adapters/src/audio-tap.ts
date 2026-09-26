/** Native PipeWire boundary: VM01 little-endian packets. All PCM is mono S16LE/16 kHz. */
export type AudioLane = "raw" | "clean" | "reference";
export type AudioPacket = Readonly<{
  lane: AudioLane;
  pcm: Buffer;
  sequence: number;
  flags: number;
  metadataSequence: number | null;
  ptsMs: number | null;
  cycleMs: number;
  callbackMs: number;
  graph: Readonly<{
    nowMs: number;
    ticks: number;
    rate: number;
    delayMs: number;
    bufferedMs: number;
    queuedBuffers: number;
  }> | null;
}>;

const HEADER = 104;
const lanes = ["raw", "clean", "reference"] as const;
const HAS_TIME = 1 << 28;
const HAS_META = 1 << 29;
const safe = (value: bigint) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("音频时间计数超出安全范围");
  return number;
};

export function createAudioDecoder(consume: (packet: AudioPacket) => void) {
  let pending = Buffer.alloc(0);
  return {
    feed(chunk: Buffer) {
      if (pending.length + chunk.length > 1024 * 1024) throw new Error("音频 IPC 缓冲超限");
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= HEADER) {
        if (pending.toString("ascii", 0, 4) !== "VM01") throw new Error("音频 IPC 协议不兼容");
        const size = pending.readUInt32LE(4);
        const lane = lanes[pending.readUInt32LE(8)];
        if (!lane || !size || size > 65536 || size % 2) throw new Error("音频 IPC 帧无效");
        if (pending.length < HEADER + size) break;
        const flags = pending.readUInt32LE(12);
        const rateNum = pending.readUInt32LE(88),
          rateDenom = pending.readUInt32LE(92);
        if (flags & HAS_TIME && (!rateNum || !rateDenom)) throw new Error("PipeWire 时间基准无效");
        const pts = pending.readBigInt64LE(32);
        const packet: AudioPacket = {
          lane,
          pcm: Buffer.from(pending.subarray(HEADER, HEADER + size)),
          flags: flags & 0xffff,
          sequence: safe(pending.readBigUInt64LE(16)),
          metadataSequence: flags & HAS_META ? safe(pending.readBigUInt64LE(24)) : null,
          ptsMs: flags & HAS_META && pts >= 0 ? Number(pts) / 1e6 : null,
          cycleMs: Number(pending.readBigUInt64LE(40)) / 1e6,
          callbackMs: Number(pending.readBigUInt64LE(48)) / 1e6,
          graph:
            flags & HAS_TIME
              ? {
                  nowMs: Number(pending.readBigInt64LE(56)) / 1e6,
                  ticks: safe(pending.readBigUInt64LE(64)),
                  rate: rateDenom / rateNum,
                  delayMs: ((Number(pending.readBigInt64LE(72)) * rateNum) / rateDenom) * 1000,
                  bufferedMs: safe(pending.readBigUInt64LE(80)) / 16,
                  queuedBuffers: pending.readUInt32LE(96),
                }
              : null,
        };
        pending = pending.subarray(HEADER + size);
        consume(packet);
      }
    },
    finish() {
      if (pending.length) throw new Error("音频 IPC 尾帧截断");
    },
  };
}
