export type AudioTimingPoint = Readonly<{
  sequence: number;
  samples: number;
  flags: number;
  callbackMs: number;
  receivedMs: number;
  ptsMs: number | null;
  graph: Readonly<{
    nowMs: number;
    ticks: number;
    rate: number;
    delayMs: number;
    bufferedMs: number;
    queuedBuffers: number;
  }> | null;
}>;
export type AudioTiming = Readonly<{
  packets: number;
  samples: number;
  sequenceGaps: number;
  discontinuities: number;
  corrupted: number;
  ptsPackets: number;
  clockJumps: number;
  maxDeliveryMs: number;
  maxCallbackGapMs: number;
  latest: AudioTimingPoint | null;
}>;
export const initialAudioTiming: AudioTiming = {
  packets: 0,
  samples: 0,
  sequenceGaps: 0,
  discontinuities: 0,
  corrupted: 0,
  ptsPackets: 0,
  clockJumps: 0,
  maxDeliveryMs: 0,
  maxCallbackGapMs: 0,
  latest: null,
};

/** Transport counters are measured. Clock jumps are diagnostic indicators, not exact lost-sample counts. */
export function advanceAudioTiming(state: AudioTiming, point: AudioTimingPoint): AudioTiming {
  const previous = state.latest;
  const graph = point.graph,
    before = previous?.graph;
  const graphDelta =
    graph && before && graph.rate === before.rate ? ((graph.ticks - before.ticks) / graph.rate) * 1000 : null;
  const wallDelta = graph && before ? graph.nowMs - before.nowMs : null;
  const clockJump =
    graphDelta !== null && wallDelta !== null && (graphDelta < 0 || Math.abs(graphDelta - wallDelta) > 30);
  return {
    packets: state.packets + 1,
    samples: state.samples + point.samples,
    sequenceGaps: state.sequenceGaps + (previous && point.sequence !== previous.sequence + 1 ? 1 : 0),
    discontinuities: state.discontinuities + (point.flags & 1 ? 1 : 0),
    corrupted: state.corrupted + (point.flags & 2 ? 1 : 0),
    ptsPackets: state.ptsPackets + (point.ptsMs === null ? 0 : 1),
    clockJumps: state.clockJumps + (clockJump ? 1 : 0),
    maxDeliveryMs: Math.max(state.maxDeliveryMs, point.receivedMs - point.callbackMs),
    maxCallbackGapMs: Math.max(state.maxCallbackGapMs, previous ? point.callbackMs - previous.callbackMs : 0),
    latest: point,
  };
}
