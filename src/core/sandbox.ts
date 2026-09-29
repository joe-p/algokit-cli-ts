import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";

import { getAppConfigDir, getAppStateDir } from "./conf.js";
import { ContainerEngine, getContainerEngine } from "./container-engine.js";
import { httpGet } from "./http.js";
import { getLogger, type LogLevel } from "./log.js";
import { run, runInteractive, type RunResult } from "./proc.js";
import {
  ALGORAND_IMAGE,
  DEFAULT_ALGOD_PORT,
  INDEXER_IMAGE,
  getAlgodNetworkTemplate,
  getConduitYaml,
  getConfigJson,
  getDockerComposeYml,
} from "./sandbox-templates.js";
import { sleepSeconds } from "./utils.js";

export {
  ALGORAND_IMAGE,
  CONDUIT_IMAGE,
  DEFAULT_ALGOD_PORT,
  INDEXER_IMAGE,
  getAlgodNetworkTemplate,
  getConduitYaml,
  getConfigJson,
  getDockerComposeYml,
} from "./sandbox-templates.js";

const logger = getLogger("algokit.core.sandbox");

export const DOCKER_COMPOSE_MINIMUM_VERSION = "2.5.0";
export const PODMAN_COMPOSE_MINIMUM_VERSION = "1.0.6";

export const SANDBOX_BASE_NAME = "sandbox";

export const DEFAULT_ALGOD_SERVER = "http://localhost";
export const DEFAULT_INDEXER_SERVER = "http://localhost";
export const DEFAULT_ALGOD_TOKEN = "a".repeat(64);
export const DEFAULT_INDEXER_TOKEN = "a".repeat(64);
export const DEFAULT_INDEXER_PORT = 8980;
export const DEFAULT_WAIT_FOR_ALGOD = 60;
export const DEFAULT_WAIT_FOR_INDEXER = 60;
export const DEFAULT_HEALTH_TIMEOUT = 1;
/** Health check timings (seconds); mutable so tests can shorten them. */
export const healthCheckTimings = {
  algodWait: DEFAULT_WAIT_FOR_ALGOD,
  indexerWait: DEFAULT_WAIT_FOR_INDEXER,
  healthTimeout: DEFAULT_HEALTH_TIMEOUT,
};
export const ALGOD_HEALTH_URL = `${DEFAULT_ALGOD_SERVER}:${DEFAULT_ALGOD_PORT}/v2/status`;
export const INDEXER_HEALTH_URL = `${DEFAULT_INDEXER_SERVER}:${DEFAULT_INDEXER_PORT}/health`;
export const IMAGE_VERSION_CHECK_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

export enum ComposeFileStatus {
  MISSING = "MISSING",
  UP_TO_DATE = "UP_TO_DATE",
  OUT_OF_DATE = "OUT_OF_DATE",
}

export function getMinComposeVersion(): string {
  return getContainerEngine() === ContainerEngine.DOCKER
    ? DOCKER_COMPOSE_MINIMUM_VERSION
    : PODMAN_COMPOSE_MINIMUM_VERSION;
}

export function composeVersionCommand(): string[] {
  return [getContainerEngine(), "compose", "version", "--format", "json"];
}

/** Extract the lines of output which are valid JSON (after stripping ANSI colour codes). */
function extractJsonLines(output: string): string[] {
  const validJsonLines: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parsedLine = stripVTControlCharacters(line);
    try {
      JSON.parse(parsedLine);
      validJsonLines.push(parsedLine);
    } catch {
      // not JSON; skip
    }
  }
  return validJsonLines;
}

export type ComposeServiceInfo = Record<string, unknown> & {
  Service?: string;
  State?: string;
  Publishers?: { PublishedPort?: number }[];
};

export class ComposeSandbox {
  readonly name: string;
  readonly directory: string;
  private readonly conduitYaml: string;
  private readonly latestYaml: string;
  private readonly latestConfigJson: string;
  private readonly latestAlgodNetworkTemplate: string;

  constructor(name: string = SANDBOX_BASE_NAME, configPath?: string) {
    this.name = name === SANDBOX_BASE_NAME ? SANDBOX_BASE_NAME : `${SANDBOX_BASE_NAME}_${name}`;
    this.directory = path.join(configPath ?? getAppConfigDir(), this.name);
    if (!existsSync(this.directory)) {
      logger.debug(`The ${this.name} directory does not exist yet; creating it`);
      mkdirSync(this.directory);
    }
    this.conduitYaml = getConduitYaml();
    this.latestYaml = getDockerComposeYml(`algokit_${this.name}`);
    this.latestConfigJson = getConfigJson();
    this.latestAlgodNetworkTemplate = getAlgodNetworkTemplate();
  }

  get composeFilePath(): string {
    return path.join(this.directory, "docker-compose.yml");
  }

  get conduitFilePath(): string {
    return path.join(this.directory, "conduit.yml");
  }

  get algodConfigFilePath(): string {
    return path.join(this.directory, "algod_config.json");
  }

  get algodNetworkTemplateFilePath(): string {
    return path.join(this.directory, "algod_network_template.json");
  }

  /** Find the currently running AlgoKit LocalNet (if any). */
  static async fromEnvironment(): Promise<ComposeSandbox | undefined> {
    let runResults: RunResult;
    try {
      runResults = await run(
        [getContainerEngine(), "compose", "ls", "--format", "json", "--filter", "name=algokit_sandbox*"],
        { badReturnCodeErrorMessage: "Failed to list running LocalNet" },
      );
      if (runResults.exitCode !== 0) return undefined;
    } catch (err) {
      logger.debug(`Error checking for existing sandbox: ${errorMessage(err)}`, { error: err });
      return undefined;
    }

    try {
      const jsonLines = extractJsonLines(runResults.output);
      const firstLine = jsonLines[0];
      if (firstLine === undefined) return undefined;
      const data: unknown = JSON.parse(firstLine);
      return ComposeSandbox.createInstanceFromData(data);
    } catch (err) {
      logger.info(`Error checking config file: ${errorMessage(err)}`, { error: err });
      return undefined;
    }
  }

  private static createInstanceFromData(data: unknown): ComposeSandbox | undefined {
    if (!Array.isArray(data)) return undefined;
    for (const item of data as Record<string, unknown>[]) {
      const configFiles = typeof item?.ConfigFiles === "string" ? item.ConfigFiles : "";
      const configFile = configFiles.split(",")[0] ?? "";
      const configDir = path.dirname(configFile);
      const fullName = path.basename(configDir);
      const name = fullName.startsWith(`${SANDBOX_BASE_NAME}_`)
        ? fullName.replace(`${SANDBOX_BASE_NAME}_`, "")
        : fullName;
      const configPath = path.dirname(configDir);
      return new ComposeSandbox(name, configPath);
    }
    return undefined;
  }

  setAlgodDevMode(devMode: boolean): void {
    const content = readFileSync(this.algodNetworkTemplateFilePath, "utf-8");
    const newContent = content.replace(/"DevMode":\s*(true|false)/g, `"DevMode": ${devMode ? "true" : "false"}`);
    writeFileSync(this.algodNetworkTemplateFilePath, newContent);
  }

  isAlgodDevMode(): boolean {
    const content = readFileSync(this.algodNetworkTemplateFilePath, "utf-8");
    return /"DevMode":\s*(true|false)/.exec(content)?.[1] === "true";
  }

  composeFileStatus(): ComposeFileStatus {
    let composeContent: string;
    let configContent: string;
    let algodNetworkTemplateContent: string;
    try {
      composeContent = readFileSync(this.composeFilePath, "utf-8");
      configContent = readFileSync(this.algodConfigFilePath, "utf-8");
      algodNetworkTemplateContent = readFileSync(this.algodNetworkTemplateFilePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // treat as out of date if compose file exists but algod config doesn't
      // so that existing setups aren't suddenly reset
      return existsSync(this.composeFilePath) ? ComposeFileStatus.OUT_OF_DATE : ComposeFileStatus.MISSING;
    }

    try {
      // Ensure the NUM_ROUNDS placeholder is the same in both files
      const parseTemplate = (content: string) =>
        JSON.parse(content.replaceAll("NUM_ROUNDS", '"NUM_ROUNDS"')) as { Genesis: Record<string, unknown> };
      const current = parseTemplate(algodNetworkTemplateContent);
      const latest = parseTemplate(this.latestAlgodNetworkTemplate);

      // Remove DevMode from comparison as the value is configurable via the `--dev` option
      if (!current.Genesis || !("DevMode" in current.Genesis)) return ComposeFileStatus.OUT_OF_DATE;
      delete current.Genesis.DevMode;
      delete latest.Genesis.DevMode;

      return composeContent === this.latestYaml &&
        configContent === this.latestConfigJson &&
        isDeepStrictEqual(current, latest)
        ? ComposeFileStatus.UP_TO_DATE
        : ComposeFileStatus.OUT_OF_DATE;
    } catch {
      // If config files are corrupted or malformed, treat as out of date
      return ComposeFileStatus.OUT_OF_DATE;
    }
  }

  writeComposeFile(): void {
    writeFileSync(this.conduitFilePath, this.conduitYaml);
    writeFileSync(this.composeFilePath, this.latestYaml);
    writeFileSync(this.algodConfigFilePath, this.latestConfigJson);
    writeFileSync(this.algodNetworkTemplateFilePath, this.latestAlgodNetworkTemplate);
  }

  private runComposeCommand(
    composeArgs: string,
    options: { stdoutLogLevel?: LogLevel; badReturnCodeErrorMessage?: string } = {},
  ): Promise<RunResult> {
    return run([getContainerEngine(), "compose", ...composeArgs.split(/\s+/).filter(Boolean)], {
      cwd: this.directory,
      stdoutLogLevel: options.stdoutLogLevel ?? "info",
      badReturnCodeErrorMessage: options.badReturnCodeErrorMessage,
    });
  }

  async up(): Promise<void> {
    logger.info("Starting AlgoKit LocalNet now...");
    const wait = getContainerEngine() === ContainerEngine.DOCKER ? " --wait" : "";
    await this.runComposeCommand(`up --detach --quiet-pull${wait}`, {
      badReturnCodeErrorMessage: "Failed to start LocalNet",
    });
    logger.debug("AlgoKit LocalNet started, waiting for health check");
    if ((await waitForAlgod()) && (await waitForIndexer())) {
      logger.info("Started; execute `algokit explore` to explore LocalNet in a web user interface.");
    } else {
      logger.warning("AlgoKit LocalNet failed to return a successful health check");
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping AlgoKit LocalNet now...");
    await this.runComposeCommand("stop", { badReturnCodeErrorMessage: "Failed to stop LocalNet" });
    logger.info("LocalNet Stopped; execute `algokit localnet start` to start it again.");
  }

  async down(): Promise<void> {
    logger.info("Cleaning up the running AlgoKit LocalNet...");
    await this.runComposeCommand("down", { stdoutLogLevel: "debug" });
  }

  async pull(): Promise<void> {
    logger.info("Fetching any container updates from DockerHub...");
    await this.runComposeCommand("pull --ignore-pull-failures --quiet");
    logger.debug("Image version cache reset");
    updateImageVersionCache({ indexerOutdated: false, algodOutdated: false });
  }

  async logs(options: { follow?: boolean; noColor?: boolean; tail?: string } = {}): Promise<void> {
    const composeArgs = ["logs"];
    if (options.follow) composeArgs.push("--follow");
    if (options.noColor) composeArgs.push("--no-color");
    if (options.tail !== undefined) composeArgs.push("--tail", options.tail);
    await runInteractive([getContainerEngine(), "compose", ...composeArgs], {
      cwd: this.directory,
      badReturnCodeErrorMessage: "Failed to get logs, are the containers running?",
    });
  }

  async ps(serviceName?: string): Promise<ComposeServiceInfo[]> {
    const runResults = await this.runComposeCommand(`ps ${serviceName ?? ""} --format json`, {
      stdoutLogLevel: "debug",
    });
    if (runResults.exitCode !== 0) return [];

    let data: unknown;
    if (runResults.output.startsWith("[")) {
      // `docker compose ps --format json` on version < 2.21.0 outputs a JSON array
      data = JSON.parse(runResults.output);
    } else {
      // `docker compose ps --format json` on version >= 2.21.0 outputs separate JSON objects, each on a new line
      data = extractJsonLines(runResults.output).map((line) => JSON.parse(line));
    }
    if (!Array.isArray(data)) throw new Error("Unexpected output from compose ps");
    return data as ComposeServiceInfo[];
  }

  /** Get the local versions of an image. Note that a single image may be pulled from multiple repo digests. */
  private async getLocalImageVersions(imageName: string): Promise<string[]> {
    try {
      const arg = "{{range .RepoDigests}}{{println .}}{{end}}";
      const result = await run([getContainerEngine(), "image", "inspect", imageName, "--format", arg]);
      return result.output
        .split(/\r?\n/)
        .filter((line, i, lines) => !(line === "" && i === lines.length - 1))
        .map((line) => (line.includes("@") ? (line.split("@")[1] ?? "") : line));
    } catch (err) {
      logger.debug(`Failed to get local image versions: ${errorMessage(err)}`, { error: err });
      return [];
    }
  }

  /** Get the latest version of an image from Docker Hub. */
  private async getLatestImageVersion(imageName: string): Promise<string | undefined> {
    const [name, tag = "latest"] = imageName.split(":");
    const url = `https://registry.hub.docker.com/v2/repositories/${name}/tags/${tag}`;
    try {
      const response = await httpGet(url);
      const data = (await response.json()) as { digest?: unknown };
      if (data.digest === undefined) throw new Error("No digest in response");
      return String(data.digest);
    } catch (err) {
      logger.debug(`Error checking image status: ${errorMessage(err)}`, { error: err });
      return undefined;
    }
  }

  async isImageUpToDate(imageName: string): Promise<boolean> {
    const localVersions = await this.getLocalImageVersions(imageName);
    const latestVersion = await this.getLatestImageVersion(imageName);
    return latestVersion === undefined || localVersions.includes(latestVersion);
  }

  async checkDockerComposeForNewImageVersions(options: { force?: boolean } = {}): Promise<void> {
    let isIndexerOutdated: boolean;
    let isAlgodOutdated: boolean;

    if (options.force || shouldCheckImageVersions()) {
      // Check Docker registry for new versions
      isIndexerOutdated = !(await this.isImageUpToDate(INDEXER_IMAGE));
      isAlgodOutdated = !(await this.isImageUpToDate(ALGORAND_IMAGE));
      updateImageVersionCache({ indexerOutdated: isIndexerOutdated, algodOutdated: isAlgodOutdated });
    } else {
      // Use cached state
      const cachedState = getImageVersionCache();
      if (!cachedState) return;
      isIndexerOutdated = cachedState.indexerOutdated;
      isAlgodOutdated = cachedState.algodOutdated;
    }

    if (isIndexerOutdated) {
      logger.warning(
        "indexer has a new version available, run `algokit localnet reset --update` to get the latest version",
      );
    }
    if (isAlgodOutdated) {
      logger.warning(
        "algod has a new version available, run `algokit localnet reset --update` to get the latest version",
      );
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ImageVersionCache {
  indexerOutdated: boolean;
  algodOutdated: boolean;
}

function imageVersionCachePath(): string {
  return path.join(getAppStateDir(), "last-localnet-version-check");
}

function getImageVersionCache(): ImageVersionCache | undefined {
  try {
    const data = JSON.parse(readFileSync(imageVersionCachePath(), "utf-8")) as Record<string, unknown>;
    return {
      indexerOutdated: Boolean(data.indexer_outdated ?? false),
      algodOutdated: Boolean(data.algod_outdated ?? false),
    };
  } catch {
    return undefined;
  }
}

function shouldCheckImageVersions(): boolean {
  const cachePath = imageVersionCachePath();
  let lastChecked: number;
  try {
    lastChecked = statSync(cachePath).mtimeMs;
  } catch {
    logger.debug(`${cachePath} inaccessible, will check for image updates`);
    return true;
  }
  const elapsedSeconds = (Date.now() - lastChecked) / 1000;
  if (elapsedSeconds > IMAGE_VERSION_CHECK_INTERVAL_SECONDS) {
    logger.debug("Image version cache expired, will check for updates");
    return true;
  }
  logger.debug(`Skipping image version check, last checked ${(elapsedSeconds / 3600).toFixed(1)}h ago`);
  return false;
}

function updateImageVersionCache(state: ImageVersionCache): void {
  try {
    writeFileSync(
      imageVersionCachePath(),
      JSON.stringify({ indexer_outdated: state.indexerOutdated, algod_outdated: state.algodOutdated }),
      "utf-8",
    );
  } catch (err) {
    logger.debug(`Failed to update image version cache: ${errorMessage(err)}`);
  }
}

/** Wait for a service to become ready via its health check endpoint. */
async function waitForService(
  url: string,
  token: string,
  headerName: string,
  serviceName: string,
  timeoutSeconds: number,
): Promise<boolean> {
  const endTime = Date.now() + timeoutSeconds * 1000;
  let lastError: unknown;
  while (Date.now() < endTime) {
    try {
      const health = await httpGet(url, {
        timeout: healthCheckTimings.healthTimeout,
        headers: { [headerName]: token },
      });
      if (health.ok) {
        logger.debug(`AlgoKit LocalNet health check successful, ${serviceName} is ready`);
        return true;
      }
      logger.debug(`AlgoKit LocalNet health check returned ${health.status}, waiting`);
    } catch (err) {
      lastError = err;
    }
    await sleepSeconds(healthCheckTimings.healthTimeout);
  }
  if (lastError) {
    logger.debug(`AlgoKit LocalNet health request failed for ${serviceName}`, { error: lastError });
  }
  return false;
}

export function waitForAlgod(): Promise<boolean> {
  return waitForService(
    ALGOD_HEALTH_URL,
    DEFAULT_ALGOD_TOKEN,
    "X-Algo-API-Token",
    "algod",
    healthCheckTimings.algodWait,
  );
}

export function waitForIndexer(): Promise<boolean> {
  return waitForService(
    INDEXER_HEALTH_URL,
    DEFAULT_INDEXER_TOKEN,
    "X-Indexer-API-Token",
    "indexer",
    healthCheckTimings.indexerWait,
  );
}

type StatusData = Record<string, string | number>;

function hasPublishedPort(serviceInfo: ComposeServiceInfo, port: number): boolean {
  const publishers = serviceInfo.Publishers;
  if (!Array.isArray(publishers)) throw new Error("Missing Publishers in service info");
  return publishers.some((item) => item.PublishedPort === port);
}

export async function fetchAlgodStatusData(serviceInfo: ComposeServiceInfo): Promise<StatusData> {
  const results: StatusData = {};
  try {
    // Search for DEFAULT_ALGOD_PORT in ports, if found use it, if not found this is an error
    if (!hasPublishedPort(serviceInfo, DEFAULT_ALGOD_PORT)) return { Status: "Error" };

    results.Port = DEFAULT_ALGOD_PORT;
    const headers = { "X-Algo-API-Token": DEFAULT_ALGOD_TOKEN };
    const statusResponse = await httpGet(`${DEFAULT_ALGOD_SERVER}:${DEFAULT_ALGOD_PORT}/v2/status`, {
      headers,
      timeout: 3,
    });
    const versionsResponse = await httpGet(`${DEFAULT_ALGOD_SERVER}:${DEFAULT_ALGOD_PORT}/versions`, {
      headers,
      timeout: 3,
    });
    if (statusResponse.status !== 200 || versionsResponse.status !== 200) return { Status: "Error" };

    const status = (await statusResponse.json()) as Record<string, unknown>;
    results["Last round"] = required(status, "last-round") as number;
    results["Time since last round"] = `${((required(status, "time-since-last-round") as number) / 1e9).toFixed(1)}s`;

    const versions = (await versionsResponse.json()) as Record<string, unknown>;
    results["Genesis ID"] = required(versions, "genesis_id") as string;
    results["Genesis hash"] = required(versions, "genesis_hash_b64") as string;
    const build = required(versions, "build") as Record<string, unknown>;
    results.Version = `${required(build, "major")}.${required(build, "minor")}.${required(build, "build_number")}`;
    return results;
  } catch (err) {
    logger.debug(`Error checking algod status: ${errorMessage(err)}`, { error: err });
    return { Status: "Error" };
  }
}

export async function fetchIndexerStatusData(serviceInfo: ComposeServiceInfo): Promise<StatusData> {
  const results: StatusData = {};
  try {
    if (!hasPublishedPort(serviceInfo, DEFAULT_INDEXER_PORT)) return { Status: "Error" };

    results.Port = DEFAULT_INDEXER_PORT;
    const healthUrl = `${DEFAULT_ALGOD_SERVER}:${DEFAULT_INDEXER_PORT}/health`;
    const httpResponse = await httpGet(healthUrl, { timeout: 5 });
    if (httpResponse.status !== 200) return { Status: "Error" };

    const response = (await httpResponse.json()) as Record<string, unknown>;
    logger.debug(`${healthUrl} response: ${JSON.stringify(response)}`);
    results["Last round"] = required(response, "round") as number;
    results.Version = required(response, "version") as string;
    return results;
  } catch (err) {
    logger.debug(`Error checking indexer status: ${errorMessage(err)}`, { error: err });
    return { Status: "Error" };
  }
}

function required(obj: Record<string, unknown>, key: string): unknown {
  if (obj === null || typeof obj !== "object" || !(key in obj)) throw new Error(`Missing key: ${key}`);
  return obj[key];
}
