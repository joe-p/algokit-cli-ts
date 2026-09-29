import { mkdirSync } from "node:fs";
import path from "node:path";

import { main } from "../../src/cli.js";
import { setConsoleWriters } from "../../src/core/log.js";

export interface InvokeResult {
  exitCode: number;
  output: string;
}

export function appConfigDir(): string {
  const dir = path.join(process.env.XDG_CONFIG_HOME!, "algokit");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function appStateDir(): string {
  const dir = path.join(process.env.XDG_STATE_HOME!, "algokit");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Invoke the CLI (with -v --no-color, as the Python test-suite does), capturing console output. */
export async function invoke(args: string | string[], options: { cwd?: string } = {}): Promise<InvokeResult> {
  const argList = typeof args === "string" ? args.split(" ").filter(Boolean) : args;
  let output = "";
  const write = (text: string) => {
    output += text;
  };
  const restore = setConsoleWriters({ stdout: write, stderr: write });
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  // capture anything written directly (e.g. commander help/usage errors)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    write(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    write(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  const priorCwd = process.cwd();
  if (options.cwd) process.chdir(options.cwd);
  try {
    const exitCode = await main(["node", "algokit", "-v", "--no-color", ...argList]);
    return { exitCode, output: normalize(output, options.cwd ?? priorCwd) };
  } finally {
    if (options.cwd) process.chdir(priorCwd);
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    restore();
  }
}

function normalize(output: string, cwd: string): string {
  return output
    .replaceAll(appConfigDir(), "{app_config}")
    .replaceAll(cwd, "{current_working_directory}")
    .replaceAll("\\", "/");
}
