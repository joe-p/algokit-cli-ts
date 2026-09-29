import { Command, InvalidArgumentError, Option } from "commander";

import {
  CODESPACE_FORWARD_TIMEOUT_MAX,
  CODESPACE_FORWARD_TIMEOUT_MIN,
  CODESPACE_NAME_PREFIX,
  authenticateWithGithub,
  createCodespace,
  deleteCodespace,
  deleteCodespacesWithPrefix,
  ensureGithubCliInstalled,
  forwardPortsForCodespace,
  isCodespaceReady,
  listGithubCodespaces,
  type CodespaceData,
} from "../core/codespace.js";
import { KeyboardInterruptError, ProcessTimeoutError } from "../core/errors.js";
import { getLogger } from "../core/log.js";
import { confirm } from "../core/prompts.js";

const logger = getLogger("algokit.cli.codespace");

export const CODESPACE_MACHINES = ["basicLinux32gb", "standardLinux32gb", "premiumLinux", "largePremiumLinux"];

export interface CodespaceOptions {
  machine: string;
  algodPort: number;
  indexerPort: number;
  kmdPort: number;
  codespaceName: string;
  repoUrl: string;
  timeout: number;
  force?: boolean;
}

export async function codespaceCommand(options: CodespaceOptions): Promise<void> {
  await ensureGithubCliInstalled();

  if (!(await authenticateWithGithub())) return;

  const codespaces = await listGithubCodespaces();

  // Delete existing codespaces with the default name
  if (
    codespaces.length > 0 &&
    (options.force ||
      (await confirm(`Delete previously used codespaces with \`${CODESPACE_NAME_PREFIX}*\` name prefix?`, {
        default: true,
      })))
  ) {
    await deleteCodespacesWithPrefix(codespaces, CODESPACE_NAME_PREFIX);
  }

  // Create a new codespace
  const codespaceName = options.codespaceName || `${CODESPACE_NAME_PREFIX}_${Math.trunc(Date.now() / 1000)}`;
  // Add a 5 minute timeout buffer, so the codespace doesn't terminate before the port forwarding
  const codespaceTimeout = Math.min(options.timeout + 5, CODESPACE_FORWARD_TIMEOUT_MAX);
  await createCodespace(options.repoUrl, codespaceName, options.machine, codespaceTimeout);

  let codespaceData: CodespaceData | undefined;
  // Ctrl+C while waiting should still clean up the codespace
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.on("SIGINT", onSigint);
  try {
    logger.info(`Waiting for codespace ${codespaceName} to be ready...`);
    codespaceData = await isCodespaceReady(codespaceName);
    if (interrupted) throw new KeyboardInterruptError();

    logger.info(`Codespace ${codespaceName} is now ready.`);
    logger.warning(
      "Keep the terminal open during the LocalNet session. " +
        "Terminating the session will delete the codespace instance.",
    );

    await forwardPortsForCodespace(codespaceData.name, options.algodPort, options.kmdPort, options.indexerPort, {
      timeout: options.timeout * 60,
    });
    logger.info("LocalNet started in GitHub Codespace");
  } catch (err) {
    if (err instanceof ProcessTimeoutError) {
      logger.warning("Timeout reached. Shutting down the codespace...");
    } else if (err instanceof KeyboardInterruptError) {
      logger.warning("Keyboard interrupt received. Shutting down the codespace...");
    } else {
      logger.error(err instanceof Error ? err.message : String(err));
    }
  } finally {
    process.off("SIGINT", onSigint);
    logger.info("Exiting...");
    if (codespaceData) await deleteCodespace(codespaceData, Boolean(options.force));
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port)) throw new InvalidArgumentError(`'${value}' is not a valid integer.`);
  return port;
}

function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isInteger(timeout)) throw new InvalidArgumentError(`'${value}' is not a valid integer.`);
  if (timeout < CODESPACE_FORWARD_TIMEOUT_MIN || timeout > CODESPACE_FORWARD_TIMEOUT_MAX) {
    throw new InvalidArgumentError(
      `Timeout must be between ${CODESPACE_FORWARD_TIMEOUT_MIN} and ${CODESPACE_FORWARD_TIMEOUT_MAX} minutes.`,
    );
  }
  return timeout;
}

export function createCodespaceCommand(): Command {
  return new Command("codespace")
    .summary("Manage the AlgoKit LocalNet in GitHub Codespaces.")
    .description("Manage the AlgoKit LocalNet in GitHub Codespaces.")
    .addOption(
      new Option("-m, --machine <machine>", "The GitHub Codespace machine type to use. Defaults to base tier.")
        .choices(CODESPACE_MACHINES)
        .default("basicLinux32gb"),
    )
    .option("-a, --algod-port <port>", "The port for the Algorand daemon. Defaults to 4001.", parsePort, 4001)
    .option("-i, --indexer-port <port>", "The port for the Algorand indexer. Defaults to 8980.", parsePort, 8980)
    .option("-k, --kmd-port <port>", "The port for the Algorand kmd. Defaults to 4002.", parsePort, 4002)
    .option(
      "-n, --codespace-name <name>",
      `The name of the codespace. Defaults to '${CODESPACE_NAME_PREFIX}_timestamp'.`,
      "",
    )
    .option(
      "-r, --repo-url <url>",
      "The URL of the repository. Defaults to algokit base template repo.",
      "algorandfoundation/algokit-base-template",
    )
    .option(
      "-t, --timeout <minutes>",
      "Default max runtime timeout in minutes. Upon hitting the timeout a codespace will be shutdown to " +
        "prevent accidental spending over GitHub Codespaces quota. Defaults to 4 hours.",
      parseTimeout,
      240,
    )
    .option(
      "-f, --force",
      `Force delete previously used codespaces with \`${CODESPACE_NAME_PREFIX}*\` name prefix and skip prompts. ` +
        "Defaults to explicitly prompting for confirmation.",
    )
    .helpOption("-h, --help", "Show this message and exit.")
    .action(async (options: CodespaceOptions) => {
      await codespaceCommand(options);
    });
}
