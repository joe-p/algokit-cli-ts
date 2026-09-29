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

export function sleepSeconds(seconds: number): Promise<void> {
  return sleep(seconds * 1000);
}
