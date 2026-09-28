import { z } from "zod";
import { characterAssetPath } from "./character.js";

export const motionLimits = {
  joints: 256,
  seconds: 60,
  keysPerTrack: 4096,
  totalJointKeys: 131072,
  rigBytes: 512 * 1024,
  clipBytes: 8 * 1024 * 1024,
} as const;

const coordinate = z.number().finite().min(-100000).max(100000);
const translation = z.tuple([coordinate, coordinate, coordinate]);
const unit = z.number().finite().min(-1).max(1);
// Qt quaternion order, deliberately different from glTF's XYZW arrays.
const rotation = z
  .tuple([unit, unit, unit, unit])
  .refine((q) => Math.abs(Math.hypot(...q) - 1) <= 0.001, "骨骼四元数须归一化（WXYZ）");
const inverseBind = z
  .array(coordinate)
  .length(16)
  .refine((m) => {
    const at = (index: number) => m[index] ?? 0;
    const determinant =
      at(0) * (at(5) * at(10) - at(6) * at(9)) -
      at(1) * (at(4) * at(10) - at(6) * at(8)) +
      at(2) * (at(4) * at(9) - at(5) * at(8));
    return (
      Math.abs(at(12)) <= 0.00001 &&
      Math.abs(at(13)) <= 0.00001 &&
      Math.abs(at(14)) <= 0.00001 &&
      Math.abs(at(15) - 1) <= 0.00001 &&
      Math.abs(determinant) > 1e-10
    );
  }, "逆绑定矩阵须为可逆的行主序仿射矩阵");
const duration = z.number().finite().positive().max(motionLimits.seconds);
export const motionClipName = z.enum(["yawn", "think", "greet"]);

export const motionRigFile = z
  .object({
    version: z.literal(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    joints: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            parent: z
              .number()
              .int()
              .min(-1)
              .max(motionLimits.joints - 1),
            translation,
            rotation,
            // Source bind pose; local TR above is the authored neutral pose.
            inverseBind,
          })
          .strict(),
      )
      .min(1)
      .max(motionLimits.joints),
    clips: z
      .array(z.object({ name: motionClipName, file: characterAssetPath, duration }).strict())
      .min(1)
      .max(3),
  })
  .strict()
  .superRefine((rig, ctx) => {
    if (new Set(rig.joints.map((joint) => joint.name)).size !== rig.joints.length)
      ctx.addIssue({ code: "custom", path: ["joints"], message: "骨骼名称不能重复" });
    rig.joints.forEach((joint, index) => {
      if (index === 0 ? joint.parent !== -1 : joint.parent < 0 || joint.parent >= index)
        ctx.addIssue({
          code: "custom",
          path: ["joints", index, "parent"],
          message: "骨架须有唯一首位根节点，父节点必须先于子节点",
        });
    });
    if (new Set(rig.clips.map((clip) => clip.name)).size !== rig.clips.length)
      ctx.addIssue({ code: "custom", path: ["clips"], message: "动作名称不能重复" });
  });

const times = z.array(z.number().finite().min(0).max(motionLimits.seconds)).min(1).max(motionLimits.keysPerTrack);
export const motionClipFile = z
  .object({
    version: z.literal(1),
    duration,
    tracks: z
      .array(
        z
          .object({
            joint: z
              .number()
              .int()
              .min(0)
              .max(motionLimits.joints - 1),
            times,
            rotations: z.array(rotation).min(1).max(motionLimits.keysPerTrack).optional(),
            translations: z.array(translation).min(1).max(motionLimits.keysPerTrack).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(motionLimits.joints),
    expression: z
      .array(z.object({ time: z.number().finite().min(0), weight: z.number().finite().min(0).max(1) }).strict())
      .max(motionLimits.keysPerTrack),
  })
  .strict()
  .superRefine((clip, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const increasing = (values: readonly number[]) =>
      values.every((time, i) => time <= clip.duration && (i === 0 || time > (values[i - 1] ?? 0)));
    if (new Set(clip.tracks.map((track) => track.joint)).size !== clip.tracks.length)
      issue(["tracks"], "同一骨骼不能有重复轨道");
    if (clip.tracks.reduce((sum, track) => sum + track.times.length, 0) > motionLimits.totalJointKeys)
      issue(["tracks"], "动作关键帧总量过大");
    clip.tracks.forEach((track, index) => {
      if (!increasing(track.times)) issue(["tracks", index, "times"], "关键帧时间须严格递增且不超过动作时长");
      if (!track.rotations && !track.translations) issue(["tracks", index], "轨道须包含旋转或位移");
      for (const channel of ["rotations", "translations"] as const)
        if (track[channel] && track[channel].length !== track.times.length)
          issue(["tracks", index, channel], "关键帧时间与变换数量不符");
    });
    if (!increasing(clip.expression.map((key) => key.time)))
      issue(["expression"], "表情时间须严格递增且不超过动作时长");
    const first = clip.expression[0],
      last = clip.expression.at(-1);
    if (
      first &&
      last &&
      (first.time !== 0 || Math.abs(last.time - clip.duration) > 1e-6 || first.weight !== 0 || last.weight !== 0)
    )
      issue(["expression"], "非空表情曲线须覆盖完整动作并从零回到零");
  });

export type MotionRigFile = z.infer<typeof motionRigFile>;
export type MotionClipFile = z.infer<typeof motionClipFile>;
export type AvatarMotionRig = Readonly<{
  version: 1;
  assetKey: string;
  joints: readonly Readonly<MotionRigFile["joints"][number]>[];
  clips: readonly Readonly<{ name: z.infer<typeof motionClipName>; url: string; duration: number }>[];
}>;

/** File-level structure plus the cross-file joint and duration constraints. */
export function validateMotionClip(
  value: unknown,
  joints: readonly Readonly<MotionRigFile["joints"][number]>[],
  expectedDuration: number,
): MotionClipFile {
  const clip = motionClipFile.parse(value);
  if (joints.length < 1 || joints.length > motionLimits.joints) throw new Error("动作骨骼数量无效");
  if (!Number.isFinite(expectedDuration) || Math.abs(clip.duration - expectedDuration) > 1e-6)
    throw new Error("动作文件与骨架清单时长不符");
  for (const track of clip.tracks) {
    const neutral = joints[track.joint];
    if (!neutral) throw new Error("动作轨道骨骼索引越界");
    if (track.times[0] !== 0 || Math.abs((track.times.at(-1) ?? 0) - clip.duration) > 1e-6)
      throw new Error("动作轨道须覆盖完整时长");
    for (const key of [0, track.times.length - 1]) {
      const position = track.translations?.[key];
      if (position?.some((value, axis) => Math.abs(value - (neutral.translation[axis] ?? 0)) > 1e-4))
        throw new Error("动作首尾位移须回到作者中性姿态");
      const quaternion = track.rotations?.[key];
      if (quaternion) {
        const difference = Math.max(
          ...quaternion.map((value, axis) => Math.abs(value - (neutral.rotation[axis] ?? 0))),
        );
        const negated = Math.max(...quaternion.map((value, axis) => Math.abs(value + (neutral.rotation[axis] ?? 0))));
        if (Math.min(difference, negated) > 1e-4) throw new Error("动作首尾旋转须回到作者中性姿态");
      }
    }
  }
  return clip;
}
