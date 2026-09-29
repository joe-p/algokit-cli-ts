import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";

import { CliError, CommandNotFoundError } from "./errors.js";
import { getLogger, style, type LogLevel } from "./log.js";

const logger = getLogger("algokit.core.proc");

export interface RunResult {
  command: string;
  exitCode: number;
  output: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  badReturnCodeErrorMessage?: string;
  prefixProcess?: boolean;
  stdoutLogLevel?: LogLevel;
  passStdin?: boolean;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  // mirror Python's subprocess behaviour of a negative signal number
  return signal ? -(constants.signals[signal] ?? 1) : -1;
}

function waitForSpawn(child: ChildProcess, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err) => reject(new CommandNotFoundError(command, { cause: err })));
  });
}

/** Split a stream into lines (keeping line endings), invoking onLine for each complete line. */
function onLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve) => {
    if (!stream) return resolve();
    let buffer = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        onLine(buffer.slice(0, index + 1));
        buffer = buffer.slice(index + 1);
      }
    });
    stream.on("end", () => {
      if (buffer) onLine(buffer);
      resolve();
    });
    stream.on("error", () => resolve());
  });
}

/**
 * Run a process, capturing stdout and stderr (interleaved) and logging each line as it is received.
 * Equivalent to algokit.core.proc.run.
 */
export async function run(command: string[], options: RunOptions = {}): Promise<RunResult> {
  const { cwd, env, badReturnCodeErrorMessage, prefixProcess = true, stdoutLogLevel = "debug", passStdin } = options;
  const commandStr = command.join(" ");
  logger.debug(`Running '${commandStr}' in '${cwd ?? process.cwd()}'`);

  const [file, ...args] = command;
  if (!file) throw new CommandNotFoundError(commandStr);
  const child = spawn(file, args, {
    cwd,
    env: env ?? process.env,
    stdio: [passStdin ? "inherit" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once("close", (code, signal) => resolve([code, signal])),
  );
  await waitForSpawn(child, file);

  const lines: string[] = [];
  const handleLine = (line: string) => {
    lines.push(line);
    const prefix = prefixProcess ? style(`${file}:`, { bold: true }) : "";
    logger.log(stdoutLogLevel, `${prefix} ${line.trim()}`);
  };
  await Promise.all([onLines(child.stdout, handleLine), onLines(child.stderr, handleLine)]);
  const exitCode = exitCodeOf(...(await closed));

  if (exitCode === 0) {
    logger.debug(`'${commandStr}' completed successfully`, { excludeFrom: "console" });
  } else {
    logger.debug(`'${commandStr}' failed, exited with code = ${exitCode}`, { excludeFrom: "console" });
    if (badReturnCodeErrorMessage) throw new CliError(badReturnCodeErrorMessage);
  }
  return { command: commandStr, exitCode, output: lines.join("") };
}

export interface RunInteractiveOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  badReturnCodeErrorMessage?: string;
}

/**
 * Run a process attached to the current terminal, logging the command being executed but not its output.
 * Equivalent to algokit.core.proc.run_interactive.
 */
export async function runInteractive(
  command: string[],
  options: RunInteractiveOptions = {},
): Promise<RunResult> {
  const { cwd, env, badReturnCodeErrorMessage } = options;
  const commandStr = command.join(" ");
  logger.debug(`Running '${commandStr}' in '${cwd ?? process.cwd()}'`);

  const [file, ...args] = command;
  if (!file) throw new CommandNotFoundError(commandStr);

  // Like a shell, let the foreground child process handle Ctrl+C rather than exiting ourselves
  const onSigint = () => {};
  process.on("SIGINT", onSigint);

  try {
    const child = spawn(file, args, { cwd, env: env ?? process.env, stdio: "inherit" });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once("close", (code, signal) => resolve([code, signal])),
    );
    await waitForSpawn(child, file);
    const exitCode = exitCodeOf(...(await closed));

    if (exitCode === 0) {
      logger.debug(`'${commandStr}' completed successfully`, { excludeFrom: "console" });
    } else {
      logger.debug(`'${commandStr}' failed, exited with code = ${exitCode}`, { excludeFrom: "console" });
      if (badReturnCodeErrorMessage) throw new CliError(badReturnCodeErrorMessage);
    }
    return { command: commandStr, exitCode, output: "" };
  } finally {
    process.off("SIGINT", onSigint);
  }
}
