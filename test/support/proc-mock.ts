import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export interface CommandMock {
  exitCode: number;
  outputLines: string[];
  notFound?: boolean;
  /** Invoked when the command is run, e.g. to create output files */
  sideEffect?: () => void;
}

export interface SpawnCall {
  command: string[];
  cwd: string | undefined;
  interactive: boolean;
}

const DEFAULT_OUTPUT = ["STDOUT", "STDERR"];

/** Mock for child_process.spawn; matches commands by (longest) prefix. */
export class ProcMock {
  private mocks = new Map<string, CommandMock>();
  calls: SpawnCall[] = [];

  reset(): void {
    this.mocks.clear();
    this.calls = [];
  }

  private key(command: string | string[]): string {
    return Array.isArray(command) ? command.join(" ") : command;
  }

  setOutput(command: string | string[], outputLines: string[], exitCode = 0, sideEffect?: () => void): void {
    this.mocks.set(this.key(command), { exitCode, outputLines, sideEffect });
  }

  shouldFail(command: string | string[], outputLines: string[] = DEFAULT_OUTPUT, exitCode = -1): void {
    this.mocks.set(this.key(command), { exitCode, outputLines });
  }

  shouldBadExit(command: string | string[], outputLines: string[] = DEFAULT_OUTPUT, exitCode = 1): void {
    this.mocks.set(this.key(command), { exitCode, outputLines });
  }

  shouldRaiseNotFound(command: string | string[]): void {
    this.mocks.set(this.key(command), { exitCode: -1, outputLines: [], notFound: true });
  }

  private lookup(commandStr: string): CommandMock {
    let best: [string, CommandMock] | undefined;
    for (const entry of this.mocks) {
      const [prefix] = entry;
      if ((commandStr === prefix || commandStr.startsWith(`${prefix} `)) && (!best || prefix.length > best[0].length)) {
        best = entry;
      }
    }
    return best?.[1] ?? { exitCode: 0, outputLines: DEFAULT_OUTPUT };
  }

  spawn(file: string, args: readonly string[], options: { cwd?: string; stdio?: unknown } = {}): EventEmitter {
    const command = [file, ...args];
    const interactive = options.stdio === "inherit";
    this.calls.push({ command, cwd: options.cwd, interactive });
    const mock = this.lookup(command.join(" "));

    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough | null;
      stderr: PassThrough | null;
      kill: () => boolean;
      unref: () => void;
    };
    child.stdout = interactive ? null : new PassThrough();
    child.stderr = interactive ? null : new PassThrough();
    child.kill = () => true;
    child.unref = () => {};

    setImmediate(() => {
      if (mock.notFound) {
        const err = Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
        child.emit("error", err);
        child.emit("close", -2, null);
        return;
      }
      child.emit("spawn");
      mock.sideEffect?.();
      if (child.stdout && child.stderr) {
        for (const line of mock.outputLines) child.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
        child.stdout.end();
        child.stderr.end();
      }
      setImmediate(() => {
        child.emit("exit", mock.exitCode, null);
        child.emit("close", mock.exitCode, null);
      });
    });
    return child;
  }
}

export const procMock = new ProcMock();
