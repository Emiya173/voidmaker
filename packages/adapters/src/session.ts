import { desktopCommand } from "./desktop.js";

/** Voice must also stop on lock when desktop observation is disabled. */
export async function sessionActive(signal: AbortSignal): Promise<boolean> {
  const state = (
    await desktopCommand("loginctl", ["show-session", "auto", "-p", "Active", "-p", "LockedHint"], signal, 4096, 1500)
  ).toString();
  const fields = new Map(
    state
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2) as [string, string]),
  );
  return fields.get("Active") === "yes" && fields.get("LockedHint") === "no";
}
