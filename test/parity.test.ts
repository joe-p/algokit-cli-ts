/**
 * Compares the output of this CLI against the approved output of the Python AlgoKit CLI test-suite
 * (copied into test/fixtures/python) for equivalent scenarios.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getAlgodNetworkTemplate, getConduitYaml, getConfigJson, getDockerComposeYml } from "../src/core/sandbox.js";
import {
  mockAlgodRunning,
  mockComposeVersion,
  mockHealthSuccess,
  mockLocalnetUpToDate,
  mockNoRunningLocalnet,
  mockRunningLocalnet,
  pyJson,
  sandboxDir,
  writeLatestCompose,
} from "./support/fixtures.js";
import { httpMock } from "./support/http-mock.js";
import { appConfigDir, invoke } from "./support/invoke.js";
import { procMock } from "./support/proc-mock.js";

function pythonFixture(name: string): string {
  return readFileSync(path.join(import.meta.dirname, "fixtures", "python", name), "utf-8");
}

/**
 * The approval files have no trailing newline; normalise both sides. The Python suite also patches
 * `_should_check_image_versions` to always return True, so drop the debug line explaining that decision.
 */
function normalise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.endsWith("inaccessible, will check for image updates"))
    .join("\n")
    .replace(/\s+$/, "");
}

describe("sandbox templates match Python", () => {
  it("config json", () => {
    expect(JSON.stringify(JSON.parse(getConfigJson()), null, 2)).toBe(normalise(pythonFixture("config_json.txt")));
  });
  it("conduit yaml", () => {
    expect(normalise(getConduitYaml())).toBe(normalise(pythonFixture("conduit_yaml.txt")));
  });
  it("docker compose yml", () => {
    expect(normalise(getDockerComposeYml())).toBe(normalise(pythonFixture("docker_compose_yml.txt")));
  });
  it("algod network template", () => {
    expect(normalise(getAlgodNetworkTemplate())).toBe(normalise(pythonFixture("algod_network_template.txt")));
  });
});

describe("command output matches Python", () => {
  it("localnet start", async () => {
    mockComposeVersion();
    mockRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();

    const result = await invoke("localnet start");

    expect(result.exitCode).toBe(0);
    const composeFile = readFileSync(path.join(appConfigDir(), "sandbox", "docker-compose.yml"), "utf-8");
    const output = `${result.output}----\n{app_config}/sandbox/docker-compose.yml:\n----\n${composeFile}`;
    expect(normalise(output)).toBe(normalise(pythonFixture("localnet_start.txt")));
  });

  it("localnet start without docker", async () => {
    procMock.shouldRaiseNotFound("docker compose version");

    const result = await invoke("localnet start");

    expect(result.exitCode).toBe(1);
    expect(normalise(result.output)).toBe(normalise(pythonFixture("localnet_start_without_docker.txt")));
  });

  it("localnet start with unparseable compose version", async () => {
    mockComposeVersion("v2.5-dev123");
    mockRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();

    const result = await invoke("localnet start");

    expect(result.exitCode).toBe(0);
    const expected = normalise(pythonFixture("localnet_start_unparseable_compose.txt")).split("\n----\n")[0]!;
    expect(normalise(result.output)).toBe(expected);
  });

  it("localnet stop", async () => {
    mockComposeVersion();
    mockRunningLocalnet();
    const dir = sandboxDir();
    writeFileSync(path.join(dir, "docker-compose.yml"), "existing");
    writeFileSync(path.join(dir, "algod_config.json"), "existing");

    const result = await invoke("localnet stop");

    expect(result.exitCode).toBe(0);
    expect(normalise(result.output)).toBe(normalise(pythonFixture("localnet_stop.txt")));
  });

  it("localnet reset with up to date config", async () => {
    mockComposeVersion();
    mockRunningLocalnet();
    mockLocalnetUpToDate();
    mockHealthSuccess();
    writeLatestCompose();

    const result = await invoke("localnet reset");

    expect(result.exitCode).toBe(0);
    expect(normalise(result.output)).toBe(normalise(pythonFixture("localnet_reset_up_to_date.txt")));
  });

  it("localnet status", async () => {
    mockComposeVersion();
    mockRunningLocalnet();
    mockLocalnetUpToDate();
    writeFileSync(path.join(sandboxDir(), "docker-compose.yml"), "existing");
    httpMock.addResponse("http://localhost:4001/v2/status", {
      "last-round": 1,
      "time-since-last-round": 15.3 * 1e9,
    });
    httpMock.addResponse("http://localhost:4001/versions", {
      genesis_id: "{genesis_id}",
      genesis_hash_b64: "{genesis_hash_b64}",
      build: { major: 1, minor: 2, build_number: 1 },
    });
    httpMock.addResponse("http://localhost:8980/health", { round: 1, errors: ["error"], version: "v1.0" });
    procMock.setOutput("docker compose ps --format json", [pyJson(COMPOSE_PS_OUTPUT)]);

    const result = await invoke("localnet status");

    expect(result.exitCode).toBe(0);
    const expected = pythonFixture("localnet_status_successful.txt")
      // intentional differences: points at the equivalent command in this CLI, and logs JSON rather than a Python repr
      .replace("`algokit config container-engine`", "`algokit localnet config`")
      .replace(
        "response: {'round': 1, 'errors': ['error'], 'version': 'v1.0'}",
        'response: {"round":1,"errors":["error"],"version":"v1.0"}',
      );
    expect(normalise(result.output)).toBe(normalise(expected));
  });

  it("localnet status when not initialised", async () => {
    mockComposeVersion();
    mockRunningLocalnet();
    mockLocalnetUpToDate();
    writeFileSync(path.join(sandboxDir(), "docker-compose.yml"), "existing");
    procMock.setOutput("docker compose ps --format json", ["[]"]);

    const result = await invoke("localnet status");

    expect(result.exitCode).toBe(1);
    const expected = pythonFixture("localnet_status_failure.txt").replace(
      "`algokit config container-engine`",
      "`algokit localnet config`",
    );
    expect(normalise(result.output)).toBe(normalise(expected));
  });

  it("goal with input and output files", async () => {
    mockNoRunningLocalnet();
    mockAlgodRunning();
    writeLatestCompose();
    const cwd = path.join(appConfigDir(), "..", "cwd");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, "approval.teal"), "\n#pragma version 8\nint 1\nreturn\n");
    const goalMount = path.join(sandboxDir(), "goal_mount");
    procMock.setOutput(
      "docker exec --interactive --workdir /root algokit_sandbox_algod goal clerk compile",
      ["File compiled"],
      0,
      () => {
        mkdirSync(goalMount, { recursive: true });
        writeFileSync(path.join(goalMount, "approval.compiled"), "compiled");
      },
    );

    const result = await invoke("goal clerk compile approval.teal -o approval.compiled", { cwd });

    expect(result.exitCode).toBe(0);
    const goalCall = procMock.calls.find((call) => call.command.includes("goal"))!;
    expect(goalCall.command[9]).toBe("/root/goal_mount/approval.teal");
    expect(goalCall.command[11]).toBe("/root/goal_mount/approval.compiled");
    expect(readFileSync(path.join(cwd, "approval.compiled"), "utf-8")).toBe("compiled");
    expect(normalise(result.output.replaceAll("docker", "{container_engine}"))).toBe(
      normalise(pythonFixture("goal_input_output_files.txt")),
    );
  });

  it("goal with out of date compose file", async () => {
    mockNoRunningLocalnet();
    writeFileSync(path.join(sandboxDir(), "docker-compose.yml"), "outdated");

    const result = await invoke("goal account list");

    expect(result.exitCode).toBe(1);
    expect(normalise(result.output.replaceAll("docker", "{container_engine}"))).toBe(
      normalise(pythonFixture("goal_compose_outdated.txt")),
    );
  });

  it("goal console", async () => {
    mockNoRunningLocalnet();
    mockAlgodRunning();
    writeLatestCompose();

    const result = await invoke("goal --console");

    expect(result.exitCode).toBe(0);
    expect(procMock.calls.at(-1)).toMatchObject({ interactive: true });
    expect(normalise(result.output.replaceAll("docker", "{container_engine}"))).toBe(
      normalise(pythonFixture("goal_console.txt")),
    );
  });
});

const COMPOSE_PS_OUTPUT = [
  {
    ID: "e900c9dfe5e4676ca7fb3ac38cbee366ca5429ae447222282b64c059f5727a47",
    Name: "algokit_algod",
    Image: "algorand/algod:latest",
    Command: "/node/run/run.sh",
    Project: "algokit_sandbox",
    Service: "algod",
    Created: 1701664778,
    State: "running",
    Status: "",
    Health: "",
    ExitCode: 0,
    Publishers: [
      { URL: "", TargetPort: 4160, PublishedPort: 0, Protocol: "tcp" },
      { URL: "0.0.0.0", TargetPort: 7833, PublishedPort: 4002, Protocol: "tcp" },
      { URL: "0.0.0.0", TargetPort: 8080, PublishedPort: 4001, Protocol: "tcp" },
      { URL: "", TargetPort: 9100, PublishedPort: 0, Protocol: "tcp" },
      { URL: "0.0.0.0", TargetPort: 9392, PublishedPort: 9392, Protocol: "tcp" },
    ],
  },
  {
    ID: "2ba986bf8539527dbc1f2c3e9d8f83e834099ffea30d31f341691b172748464f",
    Name: "algokit_conduit",
    Image: "algorandfoundation/conduit-localnet:latest",
    Command: "docker-entrypoint.sh",
    Project: "algokit_sandbox",
    Service: "conduit",
    Created: 1701664778,
    State: "running",
    Status: "",
    Health: "",
    ExitCode: 0,
    Publishers: [],
  },
  {
    ID: "fa5b36dddbd112eb8b52ccd4de7db47c55ad49124b0483896a23f6727335cb3d",
    Name: "algokit_sandbox-indexer-1",
    Image: "algorand/indexer:latest",
    Command: "docker-entrypoint.sh daemon --enable-all-parameters",
    Project: "algokit_sandbox",
    Service: "indexer",
    Created: 1701664778,
    State: "running",
    Status: "",
    Health: "",
    ExitCode: 0,
    Publishers: [{ URL: "0.0.0.0", TargetPort: 8980, PublishedPort: 8980, Protocol: "tcp" }],
  },
  {
    ID: "f3a0bf6fe1e1fcbff96b88f39e30bcadab4c1792234c970d654b7a34fb71e1d7",
    Name: "algokit_postgres",
    Image: "postgres:13-alpine",
    Command: "docker-entrypoint.sh postgres",
    Project: "algokit_sandbox",
    Service: "indexer-db",
    Created: 1701664778,
    State: "running",
    Status: "",
    Health: "",
    ExitCode: 0,
    Publishers: [{ URL: "0.0.0.0", TargetPort: 5432, PublishedPort: 5443, Protocol: "tcp" }],
  },
];
