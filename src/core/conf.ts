import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const PACKAGE_NAME = "algokit";

function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
  return p;
}

function getRelativeAppPath(baseDir: string): string {
  const result = path.join(expandUser(baseDir), PACKAGE_NAME);
  mkdirSync(result, { recursive: true });
  // resolve path in case of UWP sandbox redirection
  return realpathSync(result);
}

/** Application config files location - things that should persist, and potentially follow a user */
export function getAppConfigDir(): string {
  const configDir = process.platform === "win32" ? process.env.APPDATA : process.env.XDG_CONFIG_HOME;
  return getRelativeAppPath(configDir || "~/.config");
}

/** Application state files location - things the user wouldn't normally interact with directly */
export function getAppStateDir(): string {
  let stateDir: string | undefined;
  if (process.platform === "win32") {
    stateDir = process.env.LOCALAPPDATA;
  } else if (process.platform === "darwin") {
    stateDir = "~/Library/Application Support";
  } else {
    stateDir = process.env.XDG_STATE_HOME;
  }
  return getRelativeAppPath(stateDir || "~/.local/state");
}
