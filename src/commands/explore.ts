import { spawn } from "node:child_process";

import { getLogger } from "../core/log.js";
import { DEFAULT_ALGOD_PORT, DEFAULT_ALGOD_SERVER, DEFAULT_ALGOD_TOKEN, DEFAULT_INDEXER_PORT } from "../core/sandbox.js";
import { isWsl } from "../core/utils.js";

const logger = getLogger("algokit.cli.explore");

interface NetworkConfiguration {
  algod_url: string;
  indexer_url: string;
  algod_port?: number;
  algod_token?: string;
  indexer_port?: number;
  indexer_token?: string;
  kmd_token?: string;
  kmd_port?: number;
  kmd_url?: string;
}

function localnetConfiguration(): NetworkConfiguration {
  const gitpodUrl = process.env.GITPOD_WORKSPACE_URL;
  const codespaceName = process.env.CODESPACE_NAME;
  let urls: Pick<NetworkConfiguration, "algod_url" | "indexer_url" | "kmd_url">;
  let ports: Pick<NetworkConfiguration, "algod_port" | "indexer_port" | "kmd_port">;
  if (gitpodUrl) {
    urls = {
      algod_url: gitpodUrl.replace("https://", "https://4001-"),
      indexer_url: gitpodUrl.replace("https://", "https://8980-"),
      kmd_url: gitpodUrl.replace("https://", "https://4002-"),
    };
    ports = { algod_port: 443, indexer_port: 443, kmd_port: 443 };
  } else if (codespaceName) {
    urls = {
      algod_url: `https://${codespaceName}-4001.app.github.dev`,
      indexer_url: `https://${codespaceName}-8980.app.github.dev`,
      kmd_url: `https://${codespaceName}-4002.app.github.dev`,
    };
    ports = { algod_port: 443, indexer_port: 443, kmd_port: 443 };
  } else {
    urls = { algod_url: DEFAULT_ALGOD_SERVER, indexer_url: DEFAULT_ALGOD_SERVER, kmd_url: DEFAULT_ALGOD_SERVER };
    ports = { algod_port: DEFAULT_ALGOD_PORT, indexer_port: DEFAULT_INDEXER_PORT, kmd_port: DEFAULT_ALGOD_PORT + 1 };
  }
  return {
    algod_url: urls.algod_url,
    indexer_url: urls.indexer_url,
    algod_port: ports.algod_port,
    algod_token: DEFAULT_ALGOD_TOKEN,
    indexer_port: ports.indexer_port,
    indexer_token: DEFAULT_ALGOD_TOKEN,
    kmd_token: DEFAULT_ALGOD_TOKEN,
    kmd_port: ports.kmd_port,
    kmd_url: urls.kmd_url,
  };
}

export function getNetworks(): Record<string, NetworkConfiguration> {
  return {
    localnet: localnetConfiguration(),
    testnet: {
      algod_url: "https://testnet-api.algonode.cloud",
      indexer_url: "https://testnet-idx.algonode.cloud",
    },
    mainnet: {
      algod_url: "https://mainnet-api.algonode.cloud",
      indexer_url: "https://mainnet-idx.algonode.cloud",
    },
  };
}

export const NETWORK_NAMES = ["localnet", "testnet", "mainnet"] as const;

function getAlgokitUrl(network: string): string {
  return `https://explore.algokit.io/${network}`;
}

const QUERY_KEYS = ["algod_url", "algod_port", "indexer_url", "indexer_port", "kmd_url", "kmd_port"];

export function getExploreUrl(network: string): string {
  const config = getNetworks()[network];
  if (network === "localnet" && config && config.algod_url !== DEFAULT_ALGOD_SERVER) {
    const query = new URLSearchParams(
      Object.entries(config)
        .filter(([key]) => QUERY_KEYS.includes(key))
        .map(([key, value]) => [key, String(value)]),
    );
    return `${getAlgokitUrl(network)}?${query.toString()}`;
  }
  return getAlgokitUrl(network);
}

function browserCommands(url: string): string[][] {
  if (process.platform === "darwin") return [["open", url]];
  if (process.platform === "win32") return [["cmd", "/c", "start", '""', url.replace(/&/g, "^&")]];
  const commands: string[][] = [];
  if (process.env.BROWSER) commands.push([process.env.BROWSER, url]);
  if (isWsl()) commands.push(["wslview", url]);
  commands.push(["xdg-open", url], ["gio", "open", url], ["sensible-browser", url]);
  return commands;
}

function tryLaunch(command: string[]): Promise<boolean> {
  const [file, ...args] = command;
  if (!file) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "ignore", detached: true, windowsVerbatimArguments: true });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
    // some launchers keep running; treat still-running after a short delay as success
    setTimeout(() => {
      child.unref();
      resolve(true);
    }, 2000).unref();
  });
}

/** Open a URL in the user's default browser, returning false if no browser could be launched. */
export async function openBrowser(url: string): Promise<boolean> {
  for (const command of browserCommands(url)) {
    if (await tryLaunch(command)) return true;
  }
  return false;
}

export async function exploreCommand(network: string = "localnet"): Promise<void> {
  const url = getExploreUrl(network);
  logger.info(`Opening ${network} explorer in your default browser`);
  logger.info(`URL: ${url}`);

  let opened = false;
  try {
    opened = await openBrowser(url);
  } catch (err) {
    logger.debug("Error opening browser", { error: err });
  }
  if (opened) return;

  if (isWsl()) {
    logger.warning(
      "Unable to open browser from WSL environment.\n" +
        "Ensure 'wslu' is installed: (https://wslutiliti.es/wslu/install.html),\n" +
        `or open the URL manually: '${url}'.`,
    );
  } else {
    logger.warning(`Failed to open browser. Please open this URL manually: ${url}`);
  }
}
