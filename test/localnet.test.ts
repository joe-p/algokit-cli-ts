import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ALGOD_HEALTH_URL, getDockerComposeYml } from "../src/core/sandbox.js";
import {
  mockComposeVersion,
  mockHealthSuccess,
  mockLocalnetOutOfDate,
  mockLocalnetUpToDate,
  mockNoRunningLocalnet,
  mockRunningLocalnet,
  sandboxDir,
  writeLatestCompose,
} from "./support/fixtures.js";
import { httpMock } from "./support/http-mock.js";
import { appConfigDir, appStateDir, invoke } from "./support/invoke.js";
import { procMock } from "./support/proc-mock.js";

const prompts = vi.hoisted(() => ({
  confirm: vi.fn<(message: string, options?: { default?: boolean }) => Promise<boolean>>(),
}));
vi.mock("../src/core/prompts.js", () => prompts);

beforeEach(() => {
  prompts.confirm.mockReset().mockResolvedValue(true);
  mockComposeVersion();
});

function commands(): string[] {
  return procMock.calls.map((call) => call.command.join(" "));
}

describe("localnet group checks", () => {
  it.each([
    ["missing compose", () => procMock.shouldBadExit("docker compose version --format json"), "Container engine compose not found"],
    ["engine not running", () => procMock.shouldBadExit("docker version"), "Container engine isn't running"],
    [
      "old compose",
      () => mockComposeVersion("v2.2.1"),
      "Minimum compose version supported: v2.5.0, installed = v2.2.1\nPlease update your compose install",
    ],
  ])("fails when %s", async (_name, setup, message) => {
    setup();
    const result = await invoke("localnet start");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`Error: ${message}`);
  });

  it("accepts gitpod style compose versions", async () => {
    mockComposeVersion("v2.10.0-gitpod.0");
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();
    const result = await invoke("localnet start");
    expect(result.exitCode).toBe(0);
  });

  it("uses the podman minimum compose version", async () => {
    writeFileSync(path.join(appConfigDir(), "active-container-engine"), "podman");
    procMock.setOutput("podman compose version --format json", ['{"version": "1.0.5"}']);
    const result = await invoke("localnet start");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Minimum compose version supported: v1.0.6, installed = v1.0.5");
  });

  it("config skips the engine running check", async () => {
    procMock.shouldBadExit("docker version");
    mockNoRunningLocalnet();
    const result = await invoke("localnet config podman");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(path.join(appConfigDir(), "active-container-engine"), "utf-8")).toBe("podman");
  });

});

describe("localnet start", () => {
  it("writes the compose files for a fresh start", async () => {
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();

    const result = await invoke("localnet start");

    expect(result.exitCode).toBe(0);
    for (const file of ["docker-compose.yml", "algod_config.json", "algod_network_template.json", "conduit.yml"]) {
      expect(existsSync(path.join(appConfigDir(), "sandbox", file))).toBe(true);
    }
    expect(commands()).toContain("docker compose up --detach --quiet-pull --wait");
  });

  it("omits --wait for podman", async () => {
    writeFileSync(path.join(appConfigDir(), "active-container-engine"), "podman");
    procMock.setOutput("podman compose version --format json", ['{"version": "1.0.6"}']);
    procMock.setOutput("podman compose ls", ["[]"]);
    mockHealthSuccess();

    const result = await invoke("localnet start");

    expect(result.exitCode).toBe(0);
    expect(commands()).toContain("podman compose up --detach --quiet-pull");
  });

  it("creates a named localnet", async () => {
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();

    const result = await invoke("localnet start --name test");

    expect(result.exitCode).toBe(0);
    const composeYml = readFileSync(path.join(appConfigDir(), "sandbox_test", "docker-compose.yml"), "utf-8");
    expect(composeYml).toBe(getDockerComposeYml("algokit_sandbox_test"));
    expect(result.output).toContain("The named LocalNet configuration has been created in {app_config}/sandbox_test.");
    expect(result.output).toContain("A named LocalNet is running, update checks are disabled.");
  });

  it("stops a different running localnet after confirmation", async () => {
    mockRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();

    const result = await invoke("localnet start --name other");

    expect(result.exitCode).toBe(0);
    expect(prompts.confirm).toHaveBeenCalledWith(
      "This will stop any running AlgoKit LocalNet instance. Are you sure?",
      { default: true },
    );
    expect(procMock.calls.find((c) => c.command.join(" ") === "docker compose stop")?.cwd).toBe(
      path.join(appConfigDir(), "sandbox"),
    );
  });

  it("errors when declining to stop a different running localnet", async () => {
    mockRunningLocalnet();
    prompts.confirm.mockResolvedValue(false);

    const result = await invoke("localnet start --name other");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error: LocalNet is already running. Please stop it first");
  });

  it("warns when the definition is out of date", async () => {
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();
    const dir = sandboxDir();
    for (const file of ["docker-compose.yml", "algod_config.json", "algod_network_template.json"]) {
      writeFileSync(path.join(dir, file), "out of date config");
    }

    const result = await invoke("localnet start");

    expect(result.output).toContain("WARNING: LocalNet definition is out of date; please run `algokit localnet reset`");
    // the invalid network template can't be dev-mode toggled, so this errors as in Python
  });

  it("treats a compose file without algod config as out of date", async () => {
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();
    writeFileSync(path.join(sandboxDir(), "docker-compose.yml"), "out of date config");

    const result = await invoke("localnet start");

    expect(result.output).toContain("LocalNet definition is out of date");
  });

  it("warns when new image versions are available", async () => {
    mockNoRunningLocalnet();
    mockLocalnetOutOfDate();
    mockHealthSuccess();

    const result = await invoke("localnet start");

    expect(result.output).toContain("WARNING: indexer has a new version available");
    expect(result.output).toContain("WARNING: algod has a new version available");
    const cache = JSON.parse(readFileSync(path.join(appStateDir(), "last-localnet-version-check"), "utf-8"));
    expect(cache).toEqual({ indexer_outdated: true, algod_outdated: true });
  });

  it("uses the cached image version state when fresh, unless --check is passed", async () => {
    mockNoRunningLocalnet();
    mockHealthSuccess();
    writeFileSync(
      path.join(appStateDir(), "last-localnet-version-check"),
      JSON.stringify({ indexer_outdated: true, algod_outdated: false }),
    );

    const cached = await invoke("localnet start");
    expect(cached.output).toContain("Skipping image version check");
    expect(cached.output).toContain("indexer has a new version available");
    expect(commands().some((c) => c.startsWith("docker image inspect"))).toBe(false);

    mockLocalnetUpToDate();
    const checked = await invoke("localnet start --check");
    expect(checked.output).not.toContain("new version available");
    expect(commands().some((c) => c.startsWith("docker image inspect"))).toBe(true);
  });

  it("re-checks when the image version cache has expired", async () => {
    mockNoRunningLocalnet();
    mockHealthSuccess();
    mockLocalnetUpToDate();
    const cachePath = path.join(appStateDir(), "last-localnet-version-check");
    writeFileSync(cachePath, JSON.stringify({ indexer_outdated: true, algod_outdated: true }));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(cachePath, eightDaysAgo, eightDaysAgo);

    const result = await invoke("localnet start");

    expect(result.output).toContain("Image version cache expired, will check for updates");
    expect(result.output).not.toContain("new version available");
  });

  it("ignores image check command errors", async () => {
    mockNoRunningLocalnet();
    mockHealthSuccess();
    procMock.shouldFail("docker image inspect");

    const result = await invoke("localnet start");

    expect(result.exitCode).toBe(0);
  });

  it("supports --no-dev and restarts when the flag changes", async () => {
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();
    writeLatestCompose();

    const result = await invoke("localnet start --no-dev");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Refreshed 'DevMode' flag to 'False'");
    const template = readFileSync(path.join(appConfigDir(), "sandbox", "algod_network_template.json"), "utf-8");
    expect(template).toContain('"DevMode": false');
    expect(commands()).toContain("docker compose down");
    expect(commands()).toContain("docker compose up --detach --quiet-pull --wait");
  });

  it("--dev --force doesn't prompt or restart", async () => {
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    const dir = sandboxDir();
    writeLatestCompose();
    const templatePath = path.join(dir, "algod_network_template.json");
    writeFileSync(templatePath, readFileSync(templatePath, "utf-8").replace('"DevMode": true', '"DevMode": false'));

    const result = await invoke("localnet start --dev --force");

    expect(result.exitCode).toBe(0);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(commands()).not.toContain("docker compose down");
    expect(readFileSync(templatePath, "utf-8")).toContain('"DevMode": true');
  });

  it("supports a custom config dir (including via env var)", async () => {
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();
    const customDir = path.join(appConfigDir(), "..", "custom");
    mkdirSync(customDir);

    const result = await invoke(["localnet", "start", "--config-dir", customDir]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(customDir, "sandbox", "docker-compose.yml"))).toBe(true);

    const envDir = path.join(appConfigDir(), "..", "from-env");
    mkdirSync(envDir);
    process.env.ALGOKIT_LOCALNET_CONFIG_DIR = envDir;
    const envResult = await invoke("localnet start");
    expect(envResult.exitCode).toBe(0);
    expect(existsSync(path.join(envDir, "sandbox", "docker-compose.yml"))).toBe(true);
  });

  it("rejects a config dir that doesn't exist", async () => {
    const result = await invoke(["localnet", "start", "--config-dir", "/does/not/exist"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Directory '/does/not/exist' does not exist.");
  });

  it("errors when compose up fails", async () => {
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    procMock.shouldBadExit("docker compose up");

    const result = await invoke("localnet start");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error: Failed to start LocalNet");
  });

  it("warns when the health check fails", async () => {
    mockNoRunningLocalnet();
    mockLocalnetUpToDate();
    httpMock.addResponse(ALGOD_HEALTH_URL, {}, 500);

    const result = await invoke("localnet start");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("AlgoKit LocalNet health check returned 500, waiting");
    expect(result.output).toContain("WARNING: AlgoKit LocalNet failed to return a successful health check");
  });
});

describe("localnet stop", () => {
  it("does nothing when no localnet is running", async () => {
    mockNoRunningLocalnet();
    const result = await invoke("localnet stop");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("LocalNet is not running; run `algokit localnet start` to start the AlgoKit LocalNet");
  });

  it("stops a named localnet", async () => {
    mockRunningLocalnet("sandbox_test");
    writeLatestCompose("sandbox_test");
    const result = await invoke("localnet stop");
    expect(result.exitCode).toBe(0);
    expect(procMock.calls.at(-1)?.cwd).toBe(path.join(appConfigDir(), "sandbox_test"));
  });

  it("errors when stop fails", async () => {
    mockRunningLocalnet();
    writeLatestCompose();
    procMock.shouldBadExit("docker compose stop");
    const result = await invoke("localnet stop");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error: Failed to stop LocalNet");
  });
});

describe("localnet reset", () => {
  it("creates from scratch when there's no existing localnet", async () => {
    mockNoRunningLocalnet();
    mockHealthSuccess();
    const result = await invoke("localnet reset");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Existing LocalNet not found; creating from scratch...");
    expect(commands()).not.toContain("docker compose down");
  });

  it("syncs an out of date config and pulls with --update", async () => {
    mockRunningLocalnet();
    mockHealthSuccess();
    writeFileSync(path.join(sandboxDir(), "docker-compose.yml"), "out of date");

    const result = await invoke("localnet reset --update");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Syncing LocalNet configuration");
    expect(commands()).toContain("docker compose pull --ignore-pull-failures --quiet");
    expect(readFileSync(path.join(appConfigDir(), "sandbox", "docker-compose.yml"), "utf-8")).toBe(
      getDockerComposeYml(),
    );
    const cache = JSON.parse(readFileSync(path.join(appStateDir(), "last-localnet-version-check"), "utf-8"));
    expect(cache).toEqual({ indexer_outdated: false, algod_outdated: false });
  });

  it("resets a named localnet with --update after confirmation", async () => {
    mockRunningLocalnet("sandbox_test");
    mockHealthSuccess();
    writeFileSync(path.join(sandboxDir("sandbox_test"), "docker-compose.yml"), "custom");

    const result = await invoke("localnet reset --update");

    expect(result.exitCode).toBe(0);
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(readFileSync(path.join(appConfigDir(), "sandbox_test", "docker-compose.yml"), "utf-8")).toBe(
      getDockerComposeYml("algokit_sandbox_test"),
    );
  });

  it("errors when declining to reset a named localnet", async () => {
    mockRunningLocalnet("sandbox_test");
    writeFileSync(path.join(sandboxDir("sandbox_test"), "docker-compose.yml"), "custom");
    prompts.confirm.mockResolvedValue(false);

    const result = await invoke("localnet reset --update");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error: LocalNet configuration has not been reset");
  });

  it("restarts a named localnet without touching its config", async () => {
    mockRunningLocalnet("sandbox_test");
    mockHealthSuccess();
    writeFileSync(path.join(sandboxDir("sandbox_test"), "docker-compose.yml"), "custom");

    const result = await invoke("localnet reset");

    expect(result.exitCode).toBe(0);
    expect(readFileSync(path.join(appConfigDir(), "sandbox_test", "docker-compose.yml"), "utf-8")).toBe("custom");
    expect(commands()).toContain("docker compose down");
  });
});

describe("localnet status", () => {
  const service = (name: string, state = "running", ports: number[] = []) => ({
    Service: name,
    State: state,
    Publishers: ports.map((PublishedPort) => ({ PublishedPort })),
  });

  beforeEach(() => {
    mockRunningLocalnet();
    mockLocalnetUpToDate();
    writeLatestCompose();
  });

  it("reports stopped services and exits non-zero (newline delimited ps output)", async () => {
    procMock.setOutput("docker compose ps --format json", [
      JSON.stringify(service("algod", "exited")),
      JSON.stringify(service("conduit")),
      JSON.stringify(service("indexer-db")),
      JSON.stringify(service("indexer", "exited")),
    ]);

    const result = await invoke("localnet status");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("# algod status\nStatus: Not running\n# conduit status\nStatus: Running");
    expect(result.output).toContain("Error: At least one container isn't running");
  });

  it("reports an error for an unexpected port", async () => {
    procMock.setOutput("docker compose ps --format json", [
      JSON.stringify([
        service("algod", "running", [1234]),
        service("conduit"),
        service("indexer-db"),
        service("indexer", "running", [5678]),
      ]),
    ]);

    const result = await invoke("localnet status");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("# algod status\nStatus: Error\n");
    expect(result.output).toContain("# indexer status\nStatus: Error\n");
  });

  it("reports an error when a service's HTTP endpoint fails", async () => {
    procMock.setOutput("docker compose ps --format json", [
      JSON.stringify([
        service("algod", "running", [4001]),
        service("conduit"),
        service("indexer-db"),
        service("indexer", "running", [8980]),
      ]),
    ]);
    httpMock.addResponse("http://localhost:4001/v2/status", { "last-round": 1, "time-since-last-round": 1e9 });
    httpMock.addResponse("http://localhost:4001/versions", {
      genesis_id: "id",
      genesis_hash_b64: "hash",
      build: { major: 1, minor: 2, build_number: 3 },
    });
    httpMock.addException("http://localhost:8980/health", new Error("Unable to read within timeout"));

    const result = await invoke("localnet status");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Time since last round: 1.0s\nGenesis ID: id\nGenesis hash: hash\nVersion: 1.2.3");
    expect(result.output).toContain("# indexer status\nStatus: Error\n");
  });

  it("errors when a service is missing", async () => {
    procMock.setOutput("docker compose ps --format json", [
      JSON.stringify([service("algod"), service("conduit"), service("indexer-db")]),
    ]);
    const result = await invoke("localnet status");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error: LocalNet has not been initialized yet, please run 'algokit localnet start'");
  });
});

describe("localnet config", () => {
  it("restarts an active localnet with the new engine", async () => {
    mockRunningLocalnet();
    mockHealthSuccess();
    writeLatestCompose();

    const result = await invoke("localnet config podman --force");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Container engine set to `podman`");
    expect(commands()).toContain("docker compose down");
    expect(commands()).toContain("podman compose up --detach --quiet-pull");
  });

  it("requires the engine argument", async () => {
    const result = await invoke("localnet config");
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("error: missing required argument 'engine'");
  });

  it("switches back to docker without an active localnet", async () => {
    writeFileSync(path.join(appConfigDir(), "active-container-engine"), "podman");
    procMock.setOutput("podman compose version --format json", ['{"version": "1.0.6"}']);
    procMock.setOutput("podman compose ls", ["[]"]);

    const result = await invoke("localnet config docker");

    expect(result.exitCode).toBe(0);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(readFileSync(path.join(appConfigDir(), "active-container-engine"), "utf-8")).toBe("docker");
  });

  it("rejects unknown engines", async () => {
    const result = await invoke("localnet config containerd");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Allowed choices are docker, podman");
  });
});

describe("localnet logs / console", () => {
  it("runs compose logs interactively", async () => {
    const result = await invoke("localnet logs --follow --tail 10");
    expect(result.exitCode).toBe(0);
    expect(procMock.calls.at(-1)).toMatchObject({
      command: ["docker", "compose", "logs", "--follow", "--no-color", "--tail", "10"],
      cwd: path.join(appConfigDir(), "sandbox"),
      interactive: true,
    });
  });

  it("defaults the tail to all", async () => {
    await invoke("localnet logs");
    expect(procMock.calls.at(-1)?.command).toEqual(["docker", "compose", "logs", "--no-color", "--tail", "all"]);
  });

  it("errors when compose logs fails", async () => {
    procMock.shouldBadExit("docker compose logs");
    const result = await invoke("localnet logs");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error: Failed to get logs, are the containers running?");
  });

  it("opens a console via goal", async () => {
    mockNoRunningLocalnet();
    procMock.setOutput(["docker", "compose", "ps", "algod", "--format", "json"], ['[{"State": "running"}]']);
    writeLatestCompose();

    const result = await invoke("localnet console");

    expect(result.exitCode).toBe(0);
    expect(procMock.calls.at(-1)?.command).toEqual([
      "docker", "exec", "-it", "-w", "/root", "algokit_sandbox_algod", "bash",
    ]);
  });

});
