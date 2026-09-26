import { describe, expect, it } from "vitest";
import { monitorReferenceGain, pipeWireGraphSchema } from "../packages/adapters/src/pipewire-graph.js";
import { aecSettingsSchema, nearendProtectionSettings } from "../packages/contracts/src/aec.js";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";

const props = {
  volume: 1,
  mute: false,
  softMute: false,
  monitorMute: false,
  channelVolumes: [0.02, 0.02],
  softVolumes: [0.02, 0.02],
  monitorVolumes: [1, 1],
  params: ["monitor.channel-volumes", false],
};
function node(changes: Record<string, unknown> = {}) {
  const result = pipeWireGraphSchema.parse([{ id: 1, info: { params: { Props: [{ ...props, ...changes }] } } }])[0];
  if (!result) throw new Error("缺少测试节点");
  return result;
}
describe("AEC monitor reference snapshot", () => {
  it("requires explicit devices and keeps diagnostics at baseline while opting the app into protection", () => {
    const aec = { pluginDirectory: "/test/lib/spa-0.2", outputTarget: "virtual-speaker" };
    expect(() => voiceConfigSchema.parse({ aec })).toThrow("inputTarget");
    expect(() =>
      voiceConfigSchema.parse({ inputTarget: "virtual-mic", aec: { ...aec, pluginDirectory: "relative" } }),
    ).toThrow();
    const config = voiceConfigSchema.parse({ inputTarget: "virtual-mic", aec });
    expect(config.aec?.settings).toEqual(nearendProtectionSettings);
    expect(config.aec?.bargeIn).toBe(false);
    expect(voiceConfigSchema.parse({}).aec).toBeUndefined();
    expect(aecSettingsSchema.parse({}).nearendTransparency).toBe(1);
    expect(() => aecSettingsSchema.parse({ nearendTrigger: 0 })).toThrow();
  });
  it("uses linear output gain and avoids applying output volume twice", () => {
    expect(monitorReferenceGain(node())).toBe(0.02);
    expect(monitorReferenceGain(node({ params: ["monitor.channel-volumes", true] }))).toBe(1);
    expect(monitorReferenceGain(node({ monitorVolumes: [0.5, 0.5] }))).toBe(0.04);
  });
  it("rejects ambiguous hardware gain, asymmetric channels and muted references", () => {
    for (const change of [
      { softVolumes: [1, 1] },
      { channelVolumes: [0.02, 0.03] },
      { mute: true },
      { monitorMute: true },
      { softMute: true },
      { channelVolumes: [0, 0] },
      { monitorVolumes: [] },
      { params: [] },
      { monitorVolumes: [0.001, 0.001] },
    ])
      expect(() => monitorReferenceGain(node(change))).toThrow();
  });
});
