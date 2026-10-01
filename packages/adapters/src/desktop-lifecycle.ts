import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Enqueue the stop without waiting for the service containing this process. */
export async function exitDesktop(): Promise<void> {
  await promisify(execFile)("systemctl", ["--user", "--no-block", "stop", "voidmaker.target"], { timeout: 5000 });
}
