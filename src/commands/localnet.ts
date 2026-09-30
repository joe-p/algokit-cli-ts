import { statSync } from "node:fs";
import path from "node:path";

import { Argument, Command, InvalidArgumentError, Option } from "commander";

import { CONTAINER_ENGINES, getContainerEngine, saveContainerEngine } from "../core/container-engine.js";
import { CliError, CommandNotFoundError } from "../core/errors.js";
import { getColor, getLogger, style } from "../core/log.js";
import { run } from "../core/proc.js";
import { confirm } from "../core/prompts.js";
import {
  ComposeFileStatus,
  ComposeSandbox,
  SANDBOX_BASE_NAME,
  composeVersionCommand,
  fetchAlgodStatusData,
  fetchIndexerStatusData,
  getMinComposeVersion,
  type ComposeServiceInfo,
} from "../core/sandbox.js";
import { extractVersionTriple, isMinimumVersion } from "../core/utils.js";
import { goalCommand } from "./goal.js";

const logger = getLogger("algokit.cli.localnet");

export const SERVICE_NAMES = ["algod", "conduit", "indexer-db", "indexer"] as const;

/** Checks run before every localnet subcommand. */
async function checkContainerEngine(subcommand: string): Promise<void> {
  let composeVersionResult;
  try {
    composeVersionResult = await run(composeVersionCommand());
  } catch (err) {
    if (!(err instanceof CommandNotFoundError)) throw err;
    // this will only occur if the container engine isn't an executable in the user's path
    throw new CliError("Container engine not found; please install Docker or Podman and add to path.");
  }
  if (composeVersionResult.exitCode !== 0) {
    throw new CliError(
      "Container engine compose not found; please install Docker Compose or Podman Compose and add to path.",
    );
  }

  const composeMinimumVersion = getMinComposeVersion();
  let composeVersionStr: string | undefined;
  let composeVersionOk = true;
  try {
    composeVersionStr = extractVersionTriple(composeVersionResult.output);
    composeVersionOk = isMinimumVersion(composeVersionStr, composeMinimumVersion);
  } catch (err) {
    logger.warning(
      "Unable to extract compose version from output: \n" +
        composeVersionResult.output.replace(/\r?\n$/, "") +
        `\nPlease ensure a minimum of compose v${composeMinimumVersion} is used`,
      { error: err },
    );
  }
  if (!composeVersionOk) {
    throw new CliError(
      `Minimum compose version supported: v${composeMinimumVersion}, installed = v${composeVersionStr}\n` +
        "Please update your compose install",
    );
  }

  if (subcommand === "config") return;

  await run([getContainerEngine(), "version"], {
    badReturnCodeErrorMessage: "Container engine isn't running; please start it.",
  });
}

function configDirOption(help: string): Option {
  return new Option("-P, --config-dir <path>", help).env("ALGOKIT_LOCALNET_CONFIG_DIR").argParser((value) => {
    const resolved = path.resolve(value);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(resolved).isDirectory();
    } catch {
      throw new InvalidArgumentError(`Directory '${value}' does not exist.`);
    }
    if (!isDirectory) throw new InvalidArgumentError(`Directory '${value}' is a file.`);
    return resolved;
  });
}

function checkOption(): Option {
  return new Option(
    "--check",
    "Force check the Docker registry for new LocalNet image versions, ignoring the version check cache.",
  );
}

export async function configCommand(engine: string, options: { force?: boolean }): Promise<void> {
  const sandbox = await ComposeSandbox.fromEnvironment();
  const hasActiveInstance =
    sandbox !== undefined &&
    (options.force ||
      (await confirm(`Detected active localnet instance, would you like to restart it with '${engine}'?`, {
        default: true,
      })));
  if (sandbox && hasActiveInstance) {
    await sandbox.down();
    saveContainerEngine(engine);
    sandbox.writeComposeFile();
    await sandbox.up();
  } else {
    saveContainerEngine(engine);
  }
  logger.info(`Container engine set to \`${engine}\``);
}

export interface StartOptions {
  name?: string;
  configDir?: string;
  dev?: boolean;
  force?: boolean;
  check?: boolean;
}

export async function startLocalnet(options: StartOptions): Promise<void> {
  const { name, configDir, force, check } = options;
  const algodDevMode = options.dev ?? true;
  let sandbox = await ComposeSandbox.fromEnvironment();
  const fullName = name !== undefined ? `${SANDBOX_BASE_NAME}_${name}` : SANDBOX_BASE_NAME;
  if (sandbox !== undefined && fullName !== sandbox.name) {
    logger.debug("LocalNet is already running.");
    if (await confirm("This will stop any running AlgoKit LocalNet instance. Are you sure?", { default: true })) {
      await sandbox.stop();
    } else {
      throw new CliError("LocalNet is already running. Please stop it first");
    }
  }
  sandbox = new ComposeSandbox(name ?? SANDBOX_BASE_NAME, configDir);
  const composeFileStatus = sandbox.composeFileStatus();
  await sandbox.checkDockerComposeForNewImageVersions({ force: check });
  if (composeFileStatus === ComposeFileStatus.MISSING) {
    logger.debug("LocalNet compose file does not exist yet; writing it out for the first time");
    sandbox.writeComposeFile();
    if (name !== undefined) {
      logger.info(
        `The named LocalNet configuration has been created in ${sandbox.directory}. \n` +
          "You can edit the configuration by changing those files. " +
          "Running `algokit localnet reset` will ensure the configuration is applied",
      );
    }
  } else if (composeFileStatus === ComposeFileStatus.UP_TO_DATE) {
    logger.debug("LocalNet compose file does not require updating");
  } else if (composeFileStatus === ComposeFileStatus.OUT_OF_DATE && name === undefined) {
    logger.warning("LocalNet definition is out of date; please run `algokit localnet reset`");
  }
  if (name !== undefined) {
    logger.info(
      "A named LocalNet is running, update checks are disabled. If you wish to synchronize with the latest " +
        "version, run `algokit localnet reset --update`",
    );
  }
  if (sandbox.isAlgodDevMode() !== algodDevMode) {
    sandbox.setAlgodDevMode(algodDevMode);
    logger.info(`Refreshed 'DevMode' flag to '${algodDevMode ? "True" : "False"}'`);
    if (
      !force &&
      (await confirm(
        `Would you like to restart 'LocalNet' to apply 'DevMode' flag set to '${algodDevMode ? "True" : "False"}'? ` +
          "Otherwise, the next `algokit localnet reset` will restart with the new flag",
        { default: true },
      ))
    ) {
      await sandbox.down();
      await sandbox.up();
    }
  } else {
    await sandbox.up();
  }
}

export async function stopLocalnet(): Promise<void> {
  const sandbox = await ComposeSandbox.fromEnvironment();
  if (sandbox !== undefined) {
    if (sandbox.composeFileStatus() !== ComposeFileStatus.MISSING) await sandbox.stop();
  } else {
    logger.debug("LocalNet is not running; run `algokit localnet start` to start the AlgoKit LocalNet");
  }
}

export interface ResetOptions {
  update?: boolean;
  configDir?: string;
  check?: boolean;
}

export async function resetLocalnet(options: ResetOptions): Promise<void> {
  const sandbox = (await ComposeSandbox.fromEnvironment()) ?? new ComposeSandbox(undefined, options.configDir);
  const composeFileStatus = sandbox.composeFileStatus();
  if (composeFileStatus === ComposeFileStatus.MISSING) {
    logger.debug("Existing LocalNet not found; creating from scratch...");
    sandbox.writeComposeFile();
  } else if (sandbox.name === SANDBOX_BASE_NAME) {
    await sandbox.down();
    if (composeFileStatus !== ComposeFileStatus.UP_TO_DATE) {
      logger.info("Syncing LocalNet configuration");
      sandbox.writeComposeFile();
    }
    if (options.update) {
      await sandbox.pull();
    } else {
      await sandbox.checkDockerComposeForNewImageVersions({ force: options.check });
    }
  } else if (options.update) {
    if (
      await confirm(
        "A named LocalNet is running, are you sure you want to reset the LocalNet configuration " +
          `in ${sandbox.directory}?\nThis will stop the running LocalNet and overwrite any changes ` +
          "you've made to the configuration",
        { default: true },
      )
    ) {
      await sandbox.down();
      sandbox.writeComposeFile();
      await sandbox.pull();
    } else {
      throw new CliError("LocalNet configuration has not been reset");
    }
  } else {
    await sandbox.down();
  }
  await sandbox.up();
}

export async function localnetStatus(options: { check?: boolean }): Promise<void> {
  const sandbox = (await ComposeSandbox.fromEnvironment()) ?? new ComposeSandbox();

  await sandbox.checkDockerComposeForNewImageVersions({ force: options.check });

  logger.info("# container engine");
  logger.info(`Name: ${style(getContainerEngine(), { bold: true })} (change with \`algokit localnet config\`)`);

  const ps = await sandbox.ps();
  const psByName = new Map<string, ComposeServiceInfo>(ps.map((stats) => [String(stats.Service), stats]));
  // if any of the required containers does not exist (ie it's not just stopped but hasn't even been created),
  // then they will be missing from the output
  if (psByName.size !== SERVICE_NAMES.length || !SERVICE_NAMES.every((name) => psByName.has(name))) {
    throw new CliError("LocalNet has not been initialized yet, please run 'algokit localnet start'");
  }

  const outputByName = new Map<string, Record<string, string | number>>();
  for (const name of SERVICE_NAMES) {
    outputByName.set(name, { Status: psByName.get(name)?.State === "running" ? "Running" : "Not running" });
  }
  const algod = outputByName.get("algod")!;
  if (algod.Status === "Running") Object.assign(algod, await fetchAlgodStatusData(psByName.get("algod")!));
  const indexer = outputByName.get("indexer")!;
  if (indexer.Status === "Running") Object.assign(indexer, await fetchIndexerStatusData(psByName.get("indexer")!));

  for (const [serviceName, serviceInfo] of outputByName) {
    logger.info(style(`# ${serviceName} status`, { bold: true }));
    for (const [key, value] of Object.entries(serviceInfo)) {
      logger.info(`${style(`${key}:`, { bold: true })} ${value}`);
    }
  }

  // return non-zero if any container is not running
  if (![...outputByName.values()].every((item) => item.Status === "Running")) {
    throw new CliError(
      "At least one container isn't running; execute `algokit localnet start` to start the LocalNet",
    );
  }
}

export async function localnetLogs(options: { follow?: boolean; tail: string }): Promise<void> {
  const sandbox = new ComposeSandbox();
  await sandbox.logs({ follow: options.follow, noColor: getColor() === false, tail: options.tail });
}

export function createLocalnetCommand(): Command {
  const localnet = new Command("localnet")
    .summary("Manage the AlgoKit LocalNet.")
    .description("Manage the AlgoKit LocalNet.")
    .helpOption("-h, --help", "Show this message and exit.")
    .helpCommand(false)
    .hook("preAction", async (_thisCommand, actionCommand) => {
      await checkContainerEngine(actionCommand.name());
    });

  const helpOption = (cmd: Command) => cmd.helpOption("-h, --help", "Show this message and exit.");

  localnet.addCommand(
    helpOption(
      new Command("config")
        .summary("Configure the container engine for AlgoKit LocalNet.")
        .description("Set the default container engine for use by AlgoKit CLI to run LocalNet images.")
        .addArgument(new Argument("<engine>").choices(CONTAINER_ENGINES))
        .option("-f, --force", "Skip confirmation prompts. Defaults to 'yes' to all prompts.")
        .action(async (engine: string, options: { force?: boolean }) => {
          await configCommand(engine, options);
        }),
    ),
  );

  localnet.addCommand(
    helpOption(
      new Command("start")
        .summary("Start the AlgoKit LocalNet.")
        .description("Start the AlgoKit LocalNet.")
        .option(
          "-n, --name <name>",
          "Specify a name for a custom LocalNet instance. " +
            "AlgoKit will not manage the configuration of named LocalNet instances, " +
            `allowing developers to configure it in any way they need. Defaults to '${SANDBOX_BASE_NAME}'.`,
        )
        .addOption(
          configDirOption(
            "Specify the custom localnet configuration directory. Defaults to '~/.config' on UNIX and " +
              "'C:\\Users\\USERNAME\\AppData\\Roaming' on Windows.",
          ),
        )
        .option("-d, --dev", "Control whether to launch 'algod' in developer mode or not. Defaults to 'yes'.")
        .option("--no-dev", "Launch 'algod' without developer mode.")
        .option("--force", "Ignore the prompt to stop the LocalNet if it's already running.")
        .addOption(checkOption())
        .action(async (options: StartOptions) => {
          await startLocalnet(options);
        }),
    ),
  );

  localnet.addCommand(
    helpOption(
      new Command("stop")
        .summary("Stop the AlgoKit LocalNet.")
        .description("Stop the AlgoKit LocalNet.")
        .action(async () => {
          await stopLocalnet();
        }),
    ),
  );

  localnet.addCommand(
    helpOption(
      new Command("reset")
        .summary("Reset the AlgoKit LocalNet.")
        .description("Reset the AlgoKit LocalNet.")
        .option(
          "--update",
          "Enable or disable updating to the latest available LocalNet version, default: don't update",
        )
        .option("--no-update", "Don't update to the latest available LocalNet version.")
        .addOption(configDirOption("Specify the custom localnet configuration directory."))
        .addOption(checkOption())
        .action(async (options: ResetOptions) => {
          await resetLocalnet(options);
        }),
    ),
  );

  localnet.addCommand(
    helpOption(
      new Command("status")
        .summary("Check the status of the AlgoKit LocalNet.")
        .description("Check the status of the AlgoKit LocalNet.")
        .addOption(checkOption())
        .action(async (options: { check?: boolean }) => {
          await localnetStatus(options);
        }),
    ),
  );

  localnet.addCommand(
    helpOption(
      new Command("console")
        .summary(
          "Run the Algorand goal CLI against the AlgoKit LocalNet via a Bash console " +
            "so you can execute multiple goal commands and/or interact with a filesystem.",
        )
        .description(
          "Run the Algorand goal CLI against the AlgoKit LocalNet via a Bash console " +
            "so you can execute multiple goal commands and/or interact with a filesystem.",
        )
        .action(async () => {
          await goalCommand([], { console: true });
        }),
    ),
  );

  localnet.addCommand(
    helpOption(
      new Command("logs")
        .summary("See the output of the Docker containers.")
        .description("See the output of the Docker containers.")
        .option("-f, --follow", "Follow log output.")
        .option("--tail <lines>", "Number of lines to show from the end of the logs for each container.", "all")
        .action(async (options: { follow?: boolean; tail: string }) => {
          await localnetLogs(options);
        }),
    ),
  );

  return localnet;
}
