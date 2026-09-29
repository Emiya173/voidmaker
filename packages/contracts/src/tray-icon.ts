import { z } from "zod";

export const pixelIcon = z
  .object({
    rows: z.array(z.string().min(1).max(64)).min(1).max(64),
    palette: z.record(z.string().length(1), z.string().regex(/^#[0-9a-fA-F]{6}$/)),
    outline: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .strict()
  .refine(
    ({ rows, palette }) =>
      rows.every((row) => row.length === rows[0]?.length && [...row].every((cell) => cell === "." || cell in palette)),
    "托盘像素图宽度或调色板无效",
  );
export type PixelIcon = z.infer<typeof pixelIcon>;
