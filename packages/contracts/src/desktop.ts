import { z } from "zod";

export const desktopSource = z.enum(["window", "media", "region"]);
export type DesktopSource = z.infer<typeof desktopSource>;
export const desktopPolicy = z.object({
  proactive: z.boolean().default(false),
  intervalSeconds: z.int().min(60).max(3600).default(300),
  startHour: z.int().min(0).max(23).default(9),
  endHour: z.int().min(0).max(23).default(22),
  excludedApps: z
    .array(z.string().trim().min(1).max(128))
    .max(32)
    .default(["org.keepassxc.KeePassXC", "com.bitwarden.desktop"]),
});
export type DesktopPolicy = z.infer<typeof desktopPolicy>;
export type DesktopGrants = Readonly<Record<DesktopSource, number>>;
export const persistentDesktopGrant = -1;
export const desktopGrants = z.object({ window: z.int().min(-1), media: z.int().min(-1), region: z.int().min(-1) });
export const noDesktopGrants: DesktopGrants = { window: 0, media: 0, region: 0 };
export type DesktopObservation = Readonly<{
  id: string;
  source: DesktopSource;
  provider: string;
  capturedAt: string;
  expiresAt: string;
  text: string;
  imageUrl?: string;
}>;
export type DesktopSnapshot = Readonly<{
  revision: number;
  policy: DesktopPolicy;
  grants: DesktopGrants;
  observations: DesktopObservation[];
  busy: boolean;
  pauseReason: string;
  error: string;
  suggestion: string;
  nextCheckAt: number;
}>;
export const desktopCommands = [
  z.object({
    type: z.literal("desktop_grant"),
    source: desktopSource,
    minutes: z.int().min(1).max(60).default(15),
    persistent: z.boolean().default(false),
  }),
  z.object({ type: z.literal("desktop_revoke"), source: desktopSource.optional() }),
  z.object({ type: z.literal("desktop_policy"), policy: desktopPolicy }),
  z.object({ type: z.literal("desktop_read"), source: desktopSource }),
  z.object({ type: z.literal("desktop_clear") }),
  z.object({ type: z.literal("desktop_presence"), idle: z.boolean() }),
  z.object({ type: z.literal("desktop_send"), id: z.uuid(), text: z.string().trim().min(1).max(10_000) }),
] as const;
