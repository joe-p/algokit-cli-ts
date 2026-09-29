import { release } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

export function extractVersionTriple(versionStr: string): string {
  const match = /\d+\.\d+\.\d+/.exec(versionStr);
  if (!match) throw new Error("Unable to parse version number");
  return match[0];
}

export function isMinimumVersion(systemVersion: string, minimumVersion: string): boolean {
  const toParts = (v: string) =>
    v.split(".").map((part) => {
      const n = Number(part);
      if (!Number.isInteger(n)) throw new Error(`Invalid version: ${v}`);
      return n;
    });
  const system = toParts(systemVersion);
  const minimum = toParts(minimumVersion);
  for (let i = 0; i < Math.max(system.length, minimum.length); i++) {
    const s = system[i];
    const m = minimum[i];
    // shorter tuples compare lower when all shared parts are equal (Python tuple semantics)
    if (s === undefined) return false;
    if (m === undefined) return true;
    if (s !== m) return s > m;
  }
  return true;
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

/** Detects if running in WSL (https://github.com/scivision/detect-windows-subsystem-for-linux) */
export function isWsl(): boolean {
  const osRelease = release();
  return osRelease.endsWith("-Microsoft") || osRelease.endsWith("microsoft-standard-WSL2");
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\x1b[K";

/** Executes a function while displaying an animated spinner in the console. */
export async function runWithAnimation<T>(target: () => Promise<T>, animationText = "Loading"): Promise<T> {
  let frame = 0;
  const render = () => {
    process.stdout.write(`\r${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${animationText}`);
    frame++;
  };
  render();
  const interval = setInterval(render, 100);
  try {
    return await target();
  } finally {
    clearInterval(interval);
    process.stdout.write(`\r${CLEAR_LINE}`);
  }
}

export function sleepSeconds(seconds: number): Promise<void> {
  return sleep(seconds * 1000);
}
