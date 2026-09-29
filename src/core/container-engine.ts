import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getAppConfigDir } from "./conf.js";

export const ContainerEngine = {
  DOCKER: "docker",
  PODMAN: "podman",
} as const;
export type ContainerEngine = (typeof ContainerEngine)[keyof typeof ContainerEngine];

export const CONTAINER_ENGINES: readonly ContainerEngine[] = [ContainerEngine.DOCKER, ContainerEngine.PODMAN];

function containerEngineConfigFile(): string {
  return path.join(getAppConfigDir(), "active-container-engine");
}

export function getContainerEngine(): string {
  const configFile = containerEngineConfigFile();
  if (existsSync(configFile)) return readFileSync(configFile, "utf-8").trim();
  return ContainerEngine.DOCKER;
}

export function saveContainerEngine(engine: string): void {
  if (!(CONTAINER_ENGINES as readonly string[]).includes(engine)) {
    throw new Error(`Invalid container engine: ${engine}`);
  }
  writeFileSync(containerEngineConfigFile(), engine);
}
