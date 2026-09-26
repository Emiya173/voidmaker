import { expect, it } from "vitest";
import { type AudioPacket, createAudioDecoder } from "../packages/adapters/src/audio-tap.js";
import { advanceAudioTiming, initialAudioTiming } from "../packages/domain/src/audio-timing.js";
import {
  appendVoiceFrame,
  initialVoiceBuffer,
  interruptVoiceBuffer,
  takeVoiceBuffer,
  voiceBufferLimits,
} from "../packages/domain/src/voice-buffer.js";

function packet(lane: number, pcm = Buffer.from([123, 0, 45, 1])) {
  const header = Buffer.alloc(104);
  header.write("VM01");
  header.writeUInt32LE(pcm.length, 4);
  header.writeUInt32LE(lane, 8);
  header.writeUInt32LE((1 << 28) | (1 << 29), 12);
  header.writeBigUInt64LE(12n, 16);
  header.writeBigUInt64LE(88n, 24);
  header.writeBigInt64LE(123000000n, 32);
  header.writeBigUInt64LE(200000000n, 40);
  header.writeBigUInt64LE(201000000n, 48);
  header.writeBigInt64LE(199000000n, 56);
  header.writeBigUInt64LE(48000n, 64);
  header.writeBigInt64LE(960n, 72);
  header.writeBigUInt64LE(160n, 80);
  header.writeUInt32LE(1, 88);
  header.writeUInt32LE(48000, 92);
  header.writeUInt32LE(2, 96);
  return Buffer.concat([header, pcm]);
}
it("decodes interleaved lanes across arbitrary pipe chunks without modifying raw PCM", () => {
  const received: AudioPacket[] = [];
  const decoder = createAudioDecoder((value) => received.push(value));
  const bytes = Buffer.concat([packet(2), packet(0), packet(1)]);
  for (let offset = 0; offset < bytes.length; offset += 7) decoder.feed(bytes.subarray(offset, offset + 7));
  decoder.finish();
  expect(received.map((value) => value.lane)).toEqual(["reference", "raw", "clean"]);
  expect(received[1]?.pcm).toEqual(Buffer.from([123, 0, 45, 1]));
  expect(received[1]).toMatchObject({
    sequence: 12,
    metadataSequence: 88,
    ptsMs: 123,
    cycleMs: 200,
    callbackMs: 201,
    graph: { nowMs: 199, rate: 48000, delayMs: 20, bufferedMs: 10, queuedBuffers: 2 },
  });
});
it("rejects corrupt headers, unknown lanes, oversized payloads and incomplete tails", () => {
  const invalid = [packet(3), packet(0), packet(0), packet(0)];
  invalid[1]?.write("BAD!");
  invalid[2]?.writeUInt32LE(65538, 4);
  invalid[3]?.writeUInt32LE(0, 92);
  for (const bytes of invalid) expect(() => createAudioDecoder(() => {}).feed(bytes)).toThrow();
  const decoder = createAudioDecoder(() => {});
  decoder.feed(packet(0).subarray(0, 106));
  expect(() => decoder.finish()).toThrow("截断");
});
it("reports missing metadata explicitly and keeps transport gaps separate from clock indicators", () => {
  const bytes = packet(0);
  bytes.writeUInt32LE(0, 12);
  let received: AudioPacket | undefined;
  createAudioDecoder((value) => {
    received = value;
  }).feed(bytes);
  expect(received).toMatchObject({ ptsMs: null, graph: null, metadataSequence: null });
  const first = {
    sequence: 0,
    samples: 480,
    flags: 1,
    callbackMs: 100,
    receivedMs: 102,
    ptsMs: null,
    graph: { nowMs: 100, ticks: 4800, rate: 48000, delayMs: 20, bufferedMs: 0, queuedBuffers: 0 },
  };
  let state = advanceAudioTiming(initialAudioTiming, first);
  state = advanceAudioTiming(state, {
    ...first,
    sequence: 2,
    flags: 2,
    callbackMs: 200,
    receivedMs: 250,
    graph: { ...first.graph, nowMs: 200, ticks: 5000 },
  });
  expect(state).toMatchObject({
    sequenceGaps: 1,
    discontinuities: 1,
    corrupted: 1,
    clockJumps: 1,
    samples: 960,
    maxDeliveryMs: 50,
    maxCallbackGapMs: 100,
    ptsPackets: 0,
  });
});
it("freezes raw preroll, appends through player shutdown exactly once and refuses overflow", () => {
  let buffer = initialVoiceBuffer<number>();
  for (let i = 0; i < 100; i++) buffer = appendVoiceFrame(buffer, i);
  buffer = interruptVoiceBuffer(buffer);
  buffer = appendVoiceFrame(buffer, 100);
  buffer = interruptVoiceBuffer(buffer); // duplicate trigger must not erase the start
  const taken = takeVoiceBuffer(buffer);
  expect(taken.frames).toEqual(Array.from({ length: 51 }, (_, i) => i + 50));
  expect(takeVoiceBuffer(taken.state).frames).toEqual([]);
  for (let i = 101; i < 147; i++) buffer = appendVoiceFrame(buffer, i);
  expect(() => appendVoiceFrame(buffer, 147)).toThrow("衔接超时");
  expect(takeVoiceBuffer(initialVoiceBuffer()).frames).toEqual([]);
});

it("retains the full confirmation window when a longer interrupt threshold is configured", () => {
  const limits = voiceBufferLimits(1000);
  let state = initialVoiceBuffer<number>();
  for (let i = 0; i < 100; i++) state = appendVoiceFrame(state, i, limits);
  expect(state.recent.length * 30).toBeGreaterThanOrEqual(1300);
  expect(limits.maximumFrames * 30).toBeLessThanOrEqual(3000);
  state = interruptVoiceBuffer(state);
  for (let i = 100; i < 133; i++) state = appendVoiceFrame(state, i, limits);
  expect(takeVoiceBuffer(state).frames[0]).toBe(50);
});

it("keeps a soft opening when interrupt evidence arrives 1.2 seconds later", () => {
  let state = initialVoiceBuffer<string>();
  // The opening precedes strong interrupt evidence; it must survive the preroll.
  for (let i = 0; i < 100; i++) state = appendVoiceFrame(state, i === 60 ? "opening" : `frame-${i}`);
  state = interruptVoiceBuffer(state);
  for (let i = 100; i < 104; i++) state = appendVoiceFrame(state, `frame-${i}`);
  const taken = takeVoiceBuffer(state);
  expect(taken.frames).toContain("opening");
  expect(taken.frames.at(-1)).toBe("frame-103");
  expect(takeVoiceBuffer(taken.state).frames).toEqual([]);
});
