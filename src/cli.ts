import { readFileSync } from "node:fs";

import { Command, CommanderError } from "commander";

import { createGoalCommand } from "./commands/goal.js";
import { createLocalnetCommand } from "./commands/localnet.js";
import { CliError, ExitError } from "./core/errors.js";
import { echoErr, getLogger, setColor, setVerbose } from "./core/log.js";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

interface RootOptions {
  verbose?: boolean;
  color?: boolean;
}

export function createProgram(): Command {
  const program = new Command("algokit")
    .description(
      "AlgoKit is your one-stop shop to develop applications on the Algorand blockchain.\n\n" +
        "If you are getting started, please see the quick start tutorial: " +
        "https://dev.algorand.co/getting-started/algokit-quick-start/.",
    )
    .version(`algokit, version ${packageVersion()}`, "--version", "Show the version and exit.")
    .helpOption("-h, --help", "Show this message and exit.")
    .option("-v, --verbose", "Enable logging of DEBUG messages to the console.")
    .option("--color", "Force enable console output styling.")
    .option("--no-color", "Force disable console output styling.")
    .helpCommand(false)
    .configureHelp({ helpWidth: 120 })
    .hook("preAction", (thisCommand) => {
      const options = thisCommand.opts<RootOptions>();
      setVerbose(Boolean(options.verbose));
      // support NO_COLOR (ref: https://no-color.org) env var as default value
      setColor(options.color ?? (process.env.NO_COLOR ? false : undefined));
    });

  program.addCommand(createGoalCommand());
  program.addCommand(createLocalnetCommand());
  return program;
}

/** Run the CLI, returning the process exit code. */
export async function main(argv: string[] = process.argv): Promise<number> {
  const program = createProgram();
  const applyExitOverride = (command: Command) => {
    command.exitOverride();
    command.commands.forEach(applyExitOverride);
  };
  applyExitOverride(program);
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    return handleError(err);
  }
}

function handleError(err: unknown): number {
  if (err instanceof CommanderError) {
    // commander has already printed any relevant message (help, version, usage errors).
    // Like click: help shown due to a missing subcommand exits 0, and usage errors exit 2.
    if (err.code === "commander.help" || err.exitCode === 0) return 0;
    return 2;
  }
  if (err instanceof ExitError) return err.exitCode;
  if (err instanceof CliError) {
    echoErr(`Error: ${err.message}`);
    return err.exitCode;
  }
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  getLogger("root").critical(`Unhandled ${name}: ${message}`, { error: err });
  return 1;
}
