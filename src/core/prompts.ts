import { createInterface } from "node:readline";

import selectPrompt from "@inquirer/select";

import { CliError } from "./errors.js";

let lineReader: ReturnType<typeof createInterface> | undefined;
const bufferedLines: string[] = [];
const waiters: ((line: string | undefined) => void)[] = [];
let inputClosed = false;

function readLine(): Promise<string | undefined> {
  if (!lineReader) {
    lineReader = createInterface({ input: process.stdin, terminal: false });
    lineReader.on("line", (line) => {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else bufferedLines.push(line);
    });
    lineReader.on("close", () => {
      inputClosed = true;
      for (const waiter of waiters.splice(0)) waiter(undefined);
    });
  }
  const buffered = bufferedLines.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  if (inputClosed) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/** Release stdin so the process can exit (and child processes can use the terminal). */
function releaseInput(): void {
  if (lineReader && waiters.length === 0) {
    lineReader.close();
    lineReader = undefined;
    inputClosed = false;
  }
}

/** Prompt for a yes/no answer (equivalent to click.confirm); aborts on EOF. */
export async function confirm(message: string, options: { default?: boolean } = {}): Promise<boolean> {
  const defaultValue = options.default ?? false;
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  try {
    while (true) {
      process.stdout.write(`${message} ${suffix}: `);
      const answer = await readLine();
      if (answer === undefined) {
        process.stdout.write("\n");
        throw new CliError("Aborted!");
      }
      const value = answer.trim().toLowerCase();
      if (value === "") return defaultValue;
      if (value === "y" || value === "yes") return true;
      if (value === "n" || value === "no") return false;
      process.stdout.write("Error: invalid input\n");
    }
  } finally {
    releaseInput();
  }
}

/** Prompt to select one of several choices (equivalent to questionary.select); returns undefined if cancelled. */
export async function select(message: string, choices: string[]): Promise<string | undefined> {
  try {
    return await selectPrompt({ message, choices: choices.map((value) => ({ value })) });
  } catch (err) {
    if (err instanceof Error && err.name === "ExitPromptError") return undefined;
    throw err;
  }
}
