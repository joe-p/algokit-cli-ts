import { Command } from "commander";

import { getContainerEngine } from "../core/container-engine.js";
import { CliError, CommandNotFoundError, ExitError } from "../core/errors.js";
import {
  getVolumeMountPathDocker,
  getVolumeMountPathLocal,
  postProcess,
  preprocessCommandArgs,
} from "../core/goal.js";
import { getLogger } from "../core/log.js";
import { run, runInteractive, type RunResult } from "../core/proc.js";
import { ComposeFileStatus, ComposeSandbox, SANDBOX_BASE_NAME } from "../core/sandbox.js";

const logger = getLogger("algokit.cli.goal");

export interface GoalOptions {
  console?: boolean;
  interactive?: boolean;
}

export async function goalCommand(goalArgs: string[], options: GoalOptions): Promise<void> {
  const containerEngine = getContainerEngine();
  try {
    await run([containerEngine, "version"], {
      badReturnCodeErrorMessage: `${containerEngine} engine isn't running; please start it.`,
    });
  } catch (err) {
    if (!(err instanceof CommandNotFoundError)) throw err;
    // this will only occur if the container engine isn't an executable in the user's path
    const docsUrl =
      containerEngine === "docker" ? "https://www.docker.com/get-started/" : "https://podman.io/get-started";
    throw new CliError(
      `${containerEngine} not found; please install ${containerEngine} and add to path.\n` +
        `See ${docsUrl} for more information.`,
    );
  }

  const sandbox = (await ComposeSandbox.fromEnvironment()) ?? new ComposeSandbox();
  if (sandbox.name !== SANDBOX_BASE_NAME) {
    logger.info("A named LocalNet is running, goal command will be executed against the named LocalNet");
  }

  const volumeMountPathLocal = getVolumeMountPathLocal(sandbox.name);
  const volumeMountPathDocker = getVolumeMountPathDocker();

  const composeFileStatus = sandbox.composeFileStatus();
  if (composeFileStatus !== ComposeFileStatus.UP_TO_DATE && sandbox.name === SANDBOX_BASE_NAME) {
    throw new CliError("LocalNet definition is out of date; please run `algokit localnet reset` first!");
  }
  const psResult = await sandbox.ps("algod");
  if (!(psResult.length === 1 && psResult[0]?.State === "running")) {
    logger.info("LocalNet isn't running");
    await sandbox.up();
  }

  let result: RunResult;
  const containerName = `algokit_${sandbox.name}_algod`;
  if (options.console) {
    if (goalArgs.length > 0) {
      logger.warning("--console opens an interactive shell, remaining arguments are being ignored");
    }
    logger.info("Opening Bash console on the algod node; execute `exit` to return to original console");
    result = await runInteractive([containerEngine, "exec", "-it", "-w", "/root", containerName, "bash"]);
  } else {
    const cmd = [
      containerEngine,
      "exec",
      ...(options.interactive ? ["--tty"] : []),
      "--interactive",
      "--workdir",
      "/root",
      containerName,
      "goal",
    ];
    const { inputFiles, outputFiles, command } = preprocessCommandArgs(
      goalArgs,
      volumeMountPathLocal,
      volumeMountPathDocker,
    );
    cmd.push(...command);

    if (options.interactive) {
      result = await runInteractive(cmd);
    } else {
      // Try non-interactive first, fallback to interactive if it fails with input-related error
      result = await run(cmd, { passthrough: true, passStdin: true });
      if (result.exitCode !== 0 && result.output.includes("inappropriate ioctl")) {
        // Fallback to interactive mode if we detect TTY-related errors
        logger.debug("Command failed with TTY error, retrying in interactive mode");
        cmd.splice(2, 0, "--tty");
        result = await runInteractive(cmd);
      }
    }

    postProcess(inputFiles, outputFiles, volumeMountPathLocal);
  }

  if (result.exitCode !== 0) throw new ExitError(result.exitCode);
}

export function createGoalCommand(): Command {
  return new Command("goal")
    .summary("Run the Algorand goal CLI against the AlgoKit LocalNet.")
    .description(
      "Run the Algorand goal CLI against the AlgoKit LocalNet.\n\n" +
        "Look at https://dev.algorand.co/algokit/algokit-cli/goal for more information.",
    )
    .option(
      "--console",
      "Open a Bash console so you can execute multiple goal commands and/or interact with a filesystem.",
    )
    .option("--interactive", "Force running the goal command in interactive mode.")
    .argument("[goal_args...]")
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption("-h, --help", "Show this message and exit.")
    .action(async (goalArgs: string[], options: GoalOptions) => {
      await goalCommand(goalArgs, options);
    });
}
