import { access, mkdir, readFile, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { type ApplicationConfig, applicationConfig } from "../../contracts/src/config.js";

export async function loadApplicationConfig(
  path = process.env.VOIDMAKER_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "voidmaker/config.toml"),
): Promise<ApplicationConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return applicationConfig.parse({});
    throw error;
  }
  try {
    return applicationConfig.parse(parse(source));
  } catch (error) {
    throw new Error(`VoidMaker 配置无效 (${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Only reuse login credentials; config, instructions, history and caches belong to VoidMaker. */
export async function prepareCodexHome(
  directory = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "voidmaker/codex"),
  authFile = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await access(authFile);
    await symlink(authFile, join(directory, "auth.json"));
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  return directory;
}
