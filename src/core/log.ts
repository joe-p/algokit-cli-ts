import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { getAppStateDir } from "./conf.js";

export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

const LEVEL_VALUES: Record<LogLevel, number> = { debug: 10, info: 20, warning: 30, error: 40, critical: 50 };

type Color = "red" | "yellow" | "cyan" | "green";
const COLOR_CODES: Record<Color, number> = { red: 31, green: 32, yellow: 33, cyan: 36 };

export interface StyleOptions {
  fg?: Color;
  bold?: boolean;
}

/** Wrap text in ANSI styling codes (equivalent to click.style). Codes are stripped on output when colour is off. */
export function style(text: string, options: StyleOptions): string {
  let codes = "";
  if (options.fg) codes += `\x1b[${COLOR_CODES[options.fg]}m`;
  if (options.bold) codes += "\x1b[1m";
  return codes ? `${codes}${text}\x1b[0m` : text;
}

const LEVEL_STYLES: Partial<Record<LogLevel, StyleOptions>> = {
  critical: { fg: "red", bold: true },
  error: { fg: "red" },
  warning: { fg: "yellow" },
  debug: { fg: "cyan" },
};

interface OutputState {
  /** true = force colour, false = disable colour, undefined = auto-detect based on TTY */
  color: boolean | undefined;
  consoleLevel: number;
  logFileEnabled: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const state: OutputState = {
  color: undefined,
  consoleLevel: LEVEL_VALUES.info,
  logFileEnabled: true,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export function setColor(color: boolean | undefined): void {
  state.color = color;
}

/** The explicit colour preference, if any (equivalent to click's ctx.color). */
export function getColor(): boolean | undefined {
  return state.color;
}

export function setVerbose(verbose: boolean): void {
  state.consoleLevel = verbose ? LEVEL_VALUES.debug : LEVEL_VALUES.info;
}

export function setLogFileEnabled(enabled: boolean): void {
  state.logFileEnabled = enabled;
}

/** Override the console sinks, primarily for testing. Returns a function that restores the previous sinks. */
export function setConsoleWriters(writers: {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}): () => void {
  const previous = { stdout: state.stdout, stderr: state.stderr };
  state.stdout = writers.stdout;
  state.stderr = writers.stderr;
  return () => {
    state.stdout = previous.stdout;
    state.stderr = previous.stderr;
  };
}

function shouldStrip(stream: NodeJS.WriteStream): boolean {
  if (state.color !== undefined) return !state.color;
  return !stream.isTTY;
}

/** Write text to stdout exactly as given (no newline, styling or stripping). */
export function writeStdout(text: string): void {
  state.stdout(text);
}

/** Write text to stderr exactly as given (no newline, styling or stripping). */
export function writeStderr(text: string): void {
  state.stderr(text);
}

/** Print a line to stdout (equivalent to click.echo). */
export function echo(message: string): void {
  state.stdout(`${shouldStrip(process.stdout) ? stripVTControlCharacters(message) : message}\n`);
}

/** Print a line to stderr (equivalent to click.echo(err=True)). */
export function echoErr(message: string): void {
  state.stderr(`${shouldStrip(process.stderr) ? stripVTControlCharacters(message) : message}\n`);
}

const LOG_FILE_MAX_BYTES = 1 * 1024 * 1024;
const LOG_FILE_BACKUP_COUNT = 5;

function rotateLogFile(logFile: string): void {
  for (let i = LOG_FILE_BACKUP_COUNT - 1; i >= 1; i--) {
    const source = `${logFile}.${i}`;
    if (existsSync(source)) renameSync(source, `${logFile}.${i + 1}`);
  }
  const first = `${logFile}.1`;
  if (existsSync(first)) rmSync(first);
  renameSync(logFile, first);
}

function formatTimestamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

function writeToLogFile(name: string, level: LogLevel, message: string, error: unknown): void {
  if (!state.logFileEnabled) return;
  try {
    const logFile = path.join(getAppStateDir(), "cli.log");
    let line = `${formatTimestamp(new Date())} ${name} ${level.toUpperCase()} ${stripVTControlCharacters(message)}\n`;
    if (error instanceof Error && error.stack) line += `${error.stack}\n`;
    if (existsSync(logFile) && statSync(logFile).size + Buffer.byteLength(line) > LOG_FILE_MAX_BYTES) {
      rotateLogFile(logFile);
    }
    appendFileSync(logFile, line, "utf-8");
  } catch {
    // never let log file failures interrupt the CLI
  }
}

export interface LogOptions {
  /** Don't show this record on the console / in the log file */
  excludeFrom?: "console" | "logfile";
  /** Error details, written to the log file only (equivalent to exc_info=...) */
  error?: unknown;
}

function emit(name: string, level: LogLevel, message: string, options: LogOptions = {}): void {
  if (options.excludeFrom !== "logfile") writeToLogFile(name, level, message, options.error);
  if (options.excludeFrom === "console" || LEVEL_VALUES[level] < state.consoleLevel) return;

  let output = message;
  const levelStyle = LEVEL_STYLES[level];
  if (levelStyle) {
    // if the user hasn't disabled colours/styling use that, otherwise prefix the level name
    output = state.color !== false ? style(message, levelStyle) : `${level.toUpperCase()}: ${message}`;
  }
  echo(output);
}

export interface Logger {
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warning(message: string, options?: LogOptions): void;
  error(message: string, options?: LogOptions): void;
  critical(message: string, options?: LogOptions): void;
  log(level: LogLevel, message: string, options?: LogOptions): void;
}

export function getLogger(name: string): Logger {
  return {
    debug: (message, options) => emit(name, "debug", message, options),
    info: (message, options) => emit(name, "info", message, options),
    warning: (message, options) => emit(name, "warning", message, options),
    error: (message, options) => emit(name, "error", message, options),
    critical: (message, options) => emit(name, "critical", message, options),
    log: (level, message, options) => emit(name, level, message, options),
  };
}
