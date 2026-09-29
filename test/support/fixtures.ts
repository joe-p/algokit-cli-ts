import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ALGOD_HEALTH_URL,
  ALGORAND_IMAGE,
  INDEXER_HEALTH_URL,
  INDEXER_IMAGE,
  getAlgodNetworkTemplate,
  getConfigJson,
  getDockerComposeYml,
} from "../../src/core/sandbox.js";
import { httpMock } from "./http-mock.js";
import { appConfigDir } from "./invoke.js";
import { procMock } from "./proc-mock.js";

const DIGEST_ARG = "{{range .RepoDigests}}{{println .}}{{end}}";
const ALGOD_DIGEST = `sha256:${"a".repeat(64)}`;
const INDEXER_DIGEST = `sha256:${"b".repeat(64)}`;

/** Equivalent of the Python conftest `proc_mock` defaults. */
export function mockComposeVersion(version = "v2.5.0"): void {
  procMock.setOutput(["docker", "compose", "version", "--format", "json"], [pyJson({ version })]);
}

export function mockHealthSuccess(): void {
  httpMock.addResponse(ALGOD_HEALTH_URL);
  httpMock.addResponse(INDEXER_HEALTH_URL);
}

export function mockLocalnetUpToDate(): void {
  procMock.setOutput(["docker", "image", "inspect", ALGORAND_IMAGE, "--format", DIGEST_ARG], [`tag@${ALGOD_DIGEST}\n`]);
  procMock.setOutput(["docker", "image", "inspect", INDEXER_IMAGE, "--format", DIGEST_ARG], [`tag@${INDEXER_DIGEST}\n`]);
  httpMock.addResponse("https://registry.hub.docker.com/v2/repositories/algorand/indexer/tags/latest", {
    digest: INDEXER_DIGEST,
  });
  httpMock.addResponse("https://registry.hub.docker.com/v2/repositories/algorand/algod/tags/latest", {
    digest: ALGOD_DIGEST,
  });
}

export function mockLocalnetOutOfDate(): void {
  procMock.setOutput(["docker", "image", "inspect", ALGORAND_IMAGE, "--format", DIGEST_ARG], [`tag@${ALGOD_DIGEST}\n`]);
  procMock.setOutput(["docker", "image", "inspect", INDEXER_IMAGE, "--format", DIGEST_ARG], [`tag@${INDEXER_DIGEST}\n`]);
  httpMock.addResponse("https://registry.hub.docker.com/v2/repositories/algorand/indexer/tags/latest", {
    digest: `sha256:${"c".repeat(64)}`,
  });
  httpMock.addResponse("https://registry.hub.docker.com/v2/repositories/algorand/algod/tags/latest", {
    digest: `sha256:${"d".repeat(64)}`,
  });
}

/** Python formats JSON with ", " / ": " separators; match it so mocked output lines compare equal. */
export function pyJson(value: unknown): string {
  return JSON.stringify(value, null, 1)
    .replace(/\n\s*/g, " ")
    .replace(/\[ /g, "[")
    .replace(/ \]/g, "]")
    .replace(/\{ /g, "{")
    .replace(/ \}/g, "}");
}

export function mockRunningLocalnet(name = "sandbox", configDir = appConfigDir()): void {
  const composeFile = path.join(configDir, name, "docker-compose.yml");
  procMock.setOutput("docker compose ls --format json --filter name=algokit_sandbox*", [
    pyJson([{ Name: `algokit_${name}`, Status: "running", ConfigFiles: composeFile }]),
  ]);
}

export function mockNoRunningLocalnet(): void {
  procMock.setOutput("docker compose ls --format json --filter name=algokit_sandbox*", ["[]"]);
}

export function sandboxDir(name = "sandbox"): string {
  const dir = path.join(appConfigDir(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeLatestCompose(name = "sandbox"): void {
  const dir = sandboxDir(name);
  writeFileSync(path.join(dir, "docker-compose.yml"), getDockerComposeYml(`algokit_${name}`));
  writeFileSync(path.join(dir, "algod_config.json"), getConfigJson());
  writeFileSync(path.join(dir, "algod_network_template.json"), getAlgodNetworkTemplate());
}

export function mockAlgodRunning(name = "sandbox"): void {
  procMock.setOutput(
    ["docker", "compose", "ps", "algod", "--format", "json"],
    [pyJson([{ Name: `algokit_${name}_algod`, State: "running" }])],
  );
}
