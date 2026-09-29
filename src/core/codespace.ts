import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExitError, KeyboardInterruptError, ProcessTimeoutError } from "./errors.js";
import { httpGetText } from "./http.js";
import { getLogger } from "./log.js";
import { run, runInteractive } from "./proc.js";
import { confirm } from "./prompts.js";
import { isWindows, runWithAnimation, sleepSeconds } from "./utils.js";

const logger = getLogger("algokit.core.codespace");

export const CODESPACE_PORT_FORWARD_RETRY_SECONDS = 5;
export const CODESPACE_NAME_PREFIX = "algokit-localnet";
export const CODESPACE_CREATE_TIMEOUT = 60;
export const CODESPACE_CREATE_RETRY_TIMEOUT = 10;
export const CODESPACE_CONTAINER_AVAILABLE = "Available";
export const CODESPACE_TOO_MANY_ERROR_MSG = "too many codespaces";
export const CODESPACE_LOADING_MSG = "Provisioning a new codespace instance...";

// https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces
export const CODESPACE_FORWARD_TIMEOUT_MIN = 1;
export const CODESPACE_FORWARD_TIMEOUT_MAX = 240;

export interface CodespaceData {
  name: string;
  displayName: string;
  state: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "localhost", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function findNextAvailablePort(startPort: number, ignorePorts: number[]): Promise<number> {
  let port = startPort;
  while ((await isPortInUse(port)) || ignorePorts.includes(port)) port++;
  return port;
}

function formatLocalTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${tz ? ` ${tz}` : ""}`
  );
}

async function tryForwardPortsOnce(
  ports: [internal: number, external: number][],
  codespaceName: string,
  timeout: number,
): Promise<boolean> {
  const command = [
    "gh",
    "codespace",
    "ports",
    "forward",
    "--codespace",
    codespaceName,
    ...ports.map(([internalPort, externalPort]) => `${externalPort}:${internalPort}`),
  ];
  try {
    logger.info(
      "NOTE: This codespace port-forwarding attempt will auto shut down at " +
        `${formatLocalTimestamp(new Date(Date.now() + timeout * 1000))}.` +
        "  See https://docs.github.com/en/codespaces/overview#pricing for more details.",
    );
    const response = await runInteractive(command, { timeout });
    if (response.interrupted) throw new KeyboardInterruptError();
    return response.exitCode === 0;
  } catch (err) {
    if (err instanceof ProcessTimeoutError) {
      logger.debug(`Timed out trying to forward ports for codespace ${codespaceName} ${err.message}`);
      throw err;
    }
    if (err instanceof KeyboardInterruptError) throw err;
    logger.error(`Port forwarding attempt failed with error: ${errorMessage(err)}`);
    return false;
  }
}

async function ensureCommandAvailable(command: string[], errorMessageText: string): Promise<void> {
  try {
    await run(command);
  } catch (err) {
    throw new Error(errorMessageText, { cause: err });
  }
}

async function findAvailableShell(): Promise<string> {
  try {
    await ensureCommandAvailable(
      ["bash", "--version"],
      "Bash is required but not found on this system. Checking whether zsh is available...",
    );
    return "bash";
  } catch {
    await ensureCommandAvailable(
      ["zsh", "--version"],
      "Neither Bash nor Zsh is found on this Linux system. " +
        "Please make sure to install one of them before running `algokit localnet codespace`.",
    );
    return "zsh";
  }
}

/** Installs `gh` using the `webi.sh` script. */
export async function installGithubCliViaWebi(): Promise<void> {
  const script = await httpGetText(`https://webi.${isWindows() ? "ms" : "sh"}/gh`);
  const scriptExtension = isWindows() ? "ps1" : "sh";
  const scriptPath = path.join(mkdtempSync(path.join(tmpdir(), "algokit-")), `install-gh.${scriptExtension}`);
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);

  if (isWindows()) {
    await ensureCommandAvailable(
      ["powershell", "-command", "(Get-Variable PSVersionTable -ValueOnly).PSVersion"],
      "PowerShell is required but not found on this system. Refer to `https://aka.ms/install-powershell` for details.",
    );
    await run(["powershell", "-File", scriptPath]);
  } else {
    await run([await findAvailableShell(), scriptPath]);
  }
}

/** Ensures GitHub CLI (`gh`) is installed, installing it if necessary. */
export async function ensureGithubCliInstalled(): Promise<void> {
  try {
    await run(["gh", "--version"]);
    return;
  } catch {
    logger.info("Installing gh...");
  }
  try {
    await installGithubCliViaWebi();
  } catch (err) {
    logger.error(`Failed to automatically install gh cli: ${errorMessage(err)}`);
    logger.error("Please install `gh cli` manually by following official documentation at https://cli.github.com/");
    throw err;
  }
  logger.info("gh installed successfully!");
  logger.warning(
    "Restart your terminal to activate the `gh` CLI and re-run `algokit localnet codespace` to get started...",
  );
  throw new ExitError(0);
}

let githubCliAuthenticated: Promise<boolean> | undefined;

/** Checks if the user is authenticated with GitHub CLI and has the 'codespace' scope (result is cached). */
export function isGithubCliAuthenticated(): Promise<boolean> {
  githubCliAuthenticated ??= (async () => {
    try {
      const result = await run(["gh", "auth", "status"]);
      const normalizedOutput = result.output.split(/\r?\n/).join(" ").toLowerCase();
      const authenticated = normalizedOutput.includes("logged in");
      const hasCodespaceScope = normalizedOutput.includes("codespace");

      if (!authenticated) {
        logger.error("GitHub CLI authentication check failed. Please login with `gh auth login -s codespace`.");
      }
      if (!hasCodespaceScope) {
        logger.error(
          "Required 'codespace' scope is missing. " +
            "Please ensure you have the 'codespace' scope by running `gh auth refresh-token -s codespace`.",
        );
      }
      return authenticated && hasCodespaceScope;
    } catch {
      logger.error("GitHub CLI authentication check failed. Please login with `gh auth login -s codespace`.");
      return false;
    }
  })();
  return githubCliAuthenticated;
}

/** Reset the cached authentication status (for testing). */
export function resetGithubCliAuthenticationCache(): void {
  githubCliAuthenticated = undefined;
}

/** Logs the user into GitHub Codespace. */
export async function authenticateWithGithub(): Promise<boolean> {
  if (await isGithubCliAuthenticated()) return true;

  const result = await runInteractive(["gh", "auth", "login", "-s", "codespace"]);
  if (result.exitCode !== 0) {
    logger.error("Failed to start LocalNet in GitHub Codespace");
    return false;
  }
  logger.info("Logged in to GitHub Codespace");
  return true;
}

/** Lists available GitHub Codespaces. */
export async function listGithubCodespaces(): Promise<string[]> {
  if (!(await isGithubCliAuthenticated())) return [];

  const result = await run(["gh", "codespace", "list"], { passStdin: true });
  if (result.exitCode !== 0) {
    logger.error("Failed to log in to GitHub Codespaces. Run with -v flag for more details.");
    logger.debug(`${result.output} ${result.exitCode}`);
    return [];
  }
  return result.output
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => line.split("\t")[0] ?? "");
}

/** Forwards specified ports for a GitHub Codespace with retries. */
export async function forwardPortsForCodespace(
  codespaceName: string,
  algodPort: number,
  kmdPort: number,
  indexerPort: number,
  options: { maxRetries?: number; timeout?: number } = {},
): Promise<void> {
  const { maxRetries = 3, timeout = CODESPACE_FORWARD_TIMEOUT_MAX * 60 } = options;
  const ports: [number, number][] = [
    [algodPort, 4001],
    [kmdPort, 4002],
    [indexerPort, 8980],
  ];

  const occupiedPorts: number[] = [];
  for (const port of [algodPort, kmdPort, indexerPort]) {
    if (await isPortInUse(port)) occupiedPorts.push(port);
  }

  if (occupiedPorts.length > 0) {
    logger.warning(`Ports ${occupiedPorts.join(", ")} are already in use!`);
    if (await confirm("Retry on next available ports?", { default: true })) {
      logger.warning("NOTE: Ensure to update the port numbers in your Algorand related configuration files (if any).");
      const nextAlgodPort = await findNextAvailablePort(algodPort, occupiedPorts);
      const nextKmdPort = await findNextAvailablePort(kmdPort, [nextAlgodPort, ...occupiedPorts]);
      const nextIndexerPort = await findNextAvailablePort(indexerPort, [nextAlgodPort, nextKmdPort, ...occupiedPorts]);
      logger.info(
        `Retrying with ports ${nextAlgodPort} (was ${algodPort}), ` +
          `${nextKmdPort} (was ${kmdPort}), ${nextIndexerPort} (was ${indexerPort})`,
      );
      return forwardPortsForCodespace(
        codespaceName,
        occupiedPorts.includes(algodPort) ? nextAlgodPort : algodPort,
        occupiedPorts.includes(kmdPort) ? nextKmdPort : kmdPort,
        occupiedPorts.includes(indexerPort) ? nextIndexerPort : indexerPort,
        { maxRetries, timeout },
      );
    }
    return;
  }

  const initialTimestamp = Date.now();
  for (let attempt = maxRetries; attempt >= 1; attempt--) {
    const newTimeout = timeout - (Date.now() - initialTimestamp) / 1000;
    if (newTimeout < 0) throw new ProcessTimeoutError("gh codespace ports forward", timeout);
    if (await tryForwardPortsOnce(ports, codespaceName, Math.trunc(newTimeout))) {
      logger.info("Port forwarding successful.");
      return;
    }
    logger.error("Port forwarding failed!");
    if (attempt > 1) {
      await runWithAnimation(
        () => sleepSeconds(CODESPACE_PORT_FORWARD_RETRY_SECONDS),
        `Retrying (${attempt - 1} attempts left)...`,
      );
    }
  }
  throw new Error(
    "Port forwarding failed! Make sure you are not already running a localnet container on those ports.",
  );
}

/** Deletes GitHub Codespaces that start with the specified prefix. */
export async function deleteCodespacesWithPrefix(codespaces: string[], defaultName: string): Promise<void> {
  for (const codespace of codespaces.filter((cs) => cs.startsWith(defaultName))) {
    await run(["gh", "codespace", "delete", "--codespace", codespace, "--force"], { passStdin: true });
    logger.info(`Deleted unused codespace ${codespace}`);
  }
}

/** Waits until the specified codespace is ready, returning its data. */
export async function isCodespaceReady(codespaceName: string): Promise<CodespaceData> {
  let maxRetries = 10;
  while (maxRetries > 0) {
    maxRetries--;
    const statusResult = await run(
      ["gh", "codespace", "list", "--json", "displayName", "--json", "state", "--json", "name"],
      { passStdin: true },
    );
    const codespaces = JSON.parse(statusResult.output.trim()) as CodespaceData[];
    const codespaceData = codespaces.find((data) => data.displayName === codespaceName);
    if (!codespaceData) {
      await runWithAnimation(() => sleepSeconds(CODESPACE_CREATE_RETRY_TIMEOUT), CODESPACE_LOADING_MSG);
      continue;
    }
    if (statusResult.exitCode === 0 && codespaceData.state === CODESPACE_CONTAINER_AVAILABLE) {
      return codespaceData;
    }
  }
  throw new Error(
    "After 10 attempts, codespace isn't ready. Avoid codespace deletion and retry with --codespace-name.",
  );
}

/** Deletes the specified codespace (after confirmation unless forced). */
export async function deleteCodespace(codespaceData: CodespaceData, force: boolean): Promise<void> {
  if (force || (await confirm("Delete the codespace?", { default: true }))) {
    logger.warning(`Deleting the \`${codespaceData.name}\` codespace...`);
    await run(["gh", "codespace", "delete", "--codespace", codespaceData.name, "--force"], { passStdin: true });
  }
}

/** Creates a GitHub Codespace with the specified repository, display name, and machine type. */
export async function createCodespace(
  repoUrl: string,
  codespaceName: string,
  machine: string,
  timeout: number,
): Promise<void> {
  const response = await run(
    [
      "gh",
      "codespace",
      "create",
      "--repo",
      repoUrl,
      "--display-name",
      codespaceName,
      "--machine",
      machine,
      "--idle-timeout",
      `${timeout}m`,
    ],
    { passStdin: true },
  );
  if (response.exitCode !== 0 && response.output.toLowerCase().includes(CODESPACE_TOO_MANY_ERROR_MSG)) {
    throw new Error(
      "Creation failed: User's codespace limit reached. Delete unused codespaces using `gh` cli and try again.",
    );
  }
  await runWithAnimation(() => sleepSeconds(CODESPACE_CREATE_TIMEOUT), CODESPACE_LOADING_MSG);
}
