import { z } from "zod";

export const pipeWireGraphSchema = z.array(
  z
    .object({
      id: z.number().int().nonnegative(),
      info: z
        .object({
          props: z.record(z.string(), z.unknown()).optional(),
          params: z
            .object({ Props: z.array(z.unknown()).optional() })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
);

const levels = z.array(z.number().finite().positive().max(1)).min(1);
const volumeSchema = z.object({
  volume: z.number().finite().positive().max(1),
  mute: z.literal(false),
  channelVolumes: levels,
  softMute: z.literal(false),
  softVolumes: levels,
  monitorMute: z.literal(false),
  monitorVolumes: levels,
  params: z.array(z.unknown()),
});

/** Linear reference gain for equal-channel software volume; reject ambiguous routes. */
export function monitorReferenceGain(node: z.infer<typeof pipeWireGraphSchema>[number]): number {
  const parsed = node.info?.params?.Props?.map((entry) => volumeSchema.safeParse(entry)).find((value) => value.success);
  if (!parsed?.success) throw new Error("无法验证扬声器软件音量，或输出 / monitor 已静音");
  const props = parsed.data;
  const volume = props.channelVolumes[0];
  const monitor = props.monitorVolumes[0];
  if (volume === undefined || monitor === undefined) throw new Error("缺少音量声道");
  if (
    props.channelVolumes.length !== props.softVolumes.length ||
    props.channelVolumes.length !== props.monitorVolumes.length ||
    !props.channelVolumes.every((value) => value === volume) ||
    !props.softVolumes.every((value) => value === volume) ||
    !props.monitorVolumes.every((value) => value === monitor)
  )
    throw new Error("诊断参考只支持各声道等音量的软件输出；不推断硬件音量或声道平衡");
  const index = props.params.indexOf("monitor.channel-volumes");
  const followsVolume = index < 0 ? undefined : props.params[index + 1];
  if (typeof followsVolume !== "boolean") throw new Error("无法确定 monitor 是否已经应用输出音量");
  const gain = (followsVolume ? 1 : props.volume * volume) / monitor;
  if (!(gain > 0 && gain <= 1)) throw new Error("诊断参考增益超出 (0, 1]，拒绝自动放大");
  return gain;
}
