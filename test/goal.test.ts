import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { isPathOrFilename, postProcess, preprocessCommandArgs } from "../src/core/goal.js";
import {
  mockAlgodRunning,
  mockHealthSuccess,
  mockNoRunningLocalnet,
  mockRunningLocalnet,
  sandboxDir,
  writeLatestCompose,
} from "./support/fixtures.js";
import { appConfigDir, invoke } from "./support/invoke.js";
import { procMock } from "./support/proc-mock.js";

const GOAL_PREFIX = "docker exec --interactive --workdir /root algokit_sandbox_algod goal";

function goalCall() {
  return procMock.calls.find((call) => call.command.includes("goal"));
}

let cwd: string;
beforeEach(() => {
  cwd = path.join(appConfigDir(), "..", "cwd");
  mkdirSync(cwd, { recursive: true });
});

describe("goal", () => {
  beforeEach(() => {
    mockNoRunningLocalnet();
    writeLatestCompose();
  });

  it("passes arguments (including unknown options) through to goal", async () => {
    mockAlgodRunning();
    procMock.setOutput(GOAL_PREFIX, ["line one", "line two"]);

    const result = await invoke("goal account list -w unencrypted-default-wallet", { cwd });

    expect(result.exitCode).toBe(0);
    expect(goalCall()?.command.slice(7)).toEqual(["account", "list", "-w", "unencrypted-default-wallet"]);
    // goal output is logged at INFO level without a process prefix
    expect(result.output).toContain("\n line one\n line two\n");
  });

  it("propagates goal's exit code", async () => {
    mockAlgodRunning();
    procMock.shouldBadExit(GOAL_PREFIX, ["boom"], 3);

    const result = await invoke("goal wallet badcmd", { cwd });

    expect(result.exitCode).toBe(3);
    expect(result.output).not.toContain("Error:");
  });

  it("starts localnet when algod isn't running", async () => {
    procMock.setOutput(["docker", "compose", "ps", "algod", "--format", "json"], ["[]"]);
    mockHealthSuccess();

    const result = await invoke("goal node status", { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("LocalNet isn't running\nStarting AlgoKit LocalNet now...");
  });

  it("runs interactively with --interactive", async () => {
    mockAlgodRunning();

    const result = await invoke("goal --interactive account new", { cwd });

    expect(result.exitCode).toBe(0);
    expect(goalCall()).toMatchObject({
      interactive: true,
      command: [
        "docker", "exec", "--tty", "--interactive", "--workdir", "/root", "algokit_sandbox_algod",
        "goal", "account", "new",
      ],
    });
  });

  it("falls back to interactive mode on TTY errors", async () => {
    mockAlgodRunning();
    procMock.shouldBadExit(GOAL_PREFIX, ["inappropriate ioctl for device"]);

    await invoke("goal account new", { cwd });

    const calls = procMock.calls.filter((call) => call.command.includes("goal"));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ interactive: true });
    expect(calls[1]?.command.slice(0, 4)).toEqual(["docker", "exec", "--tty", "--interactive"]);
  });

  it("warns that arguments are ignored with --console", async () => {
    mockAlgodRunning();
    const result = await invoke("goal --console account list", { cwd });
    expect(result.output).toContain("WARNING: --console opens an interactive shell, remaining arguments are being ignored");
  });

  it("errors on a missing input file", async () => {
    mockAlgodRunning();

    const result = await invoke("goal clerk compile approval.teal", { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("ERROR: approval.teal does not exist.");
    expect(goalCall()).toBeUndefined();
  });

  it("copies split output files back", async () => {
    mockAlgodRunning();
    writeFileSync(path.join(cwd, "input.gtxn"), "group");
    const goalMount = path.join(sandboxDir(), "goal_mount");
    procMock.setOutput(GOAL_PREFIX, ["done"], 0, () => {
      mkdirSync(goalMount, { recursive: true });
      writeFileSync(path.join(goalMount, "output-0.txn"), "0");
      writeFileSync(path.join(goalMount, "output-1.txn"), "1");
      writeFileSync(path.join(goalMount, "unrelated.txn"), "x");
    });

    const result = await invoke("goal clerk split -i input.gtxn -o ./output.txn", { cwd });

    expect(result.exitCode).toBe(0);
    expect(goalCall()?.command.slice(-4)).toEqual([
      "-i", "/root/goal_mount/input.gtxn", "-o", "/root/goal_mount/output.txn",
    ]);
    expect(readFileSync(path.join(cwd, "output-0.txn"), "utf-8")).toBe("0");
    expect(readFileSync(path.join(cwd, "output-1.txn"), "utf-8")).toBe("1");
    expect(existsSync(path.join(cwd, "unrelated.txn"))).toBe(false);
    // input and matched output files are cleaned out of the mount
    expect(existsSync(path.join(goalMount, "input.gtxn"))).toBe(false);
    expect(existsSync(path.join(goalMount, "output-0.txn"))).toBe(false);
    expect(existsSync(path.join(goalMount, "unrelated.txn"))).toBe(true);
  });

  it("targets a named localnet", async () => {
    mockRunningLocalnet("sandbox_test");
    mockAlgodRunning("sandbox_test");
    writeFileSync(path.join(sandboxDir("sandbox_test"), "docker-compose.yml"), "custom config is fine");

    const result = await invoke("goal node status", { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("A named LocalNet is running, goal command will be executed against the named LocalNet");
    expect(goalCall()?.command).toContain("algokit_sandbox_test_algod");
  });

  it("errors helpfully when docker isn't installed", async () => {
    procMock.shouldRaiseNotFound("docker version");
    const result = await invoke("goal node status", { cwd });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "Error: docker not found; please install docker and add to path.\nSee https://www.docker.com/get-started/ for more information.",
    );
  });

  it("errors when the engine isn't running", async () => {
    procMock.shouldBadExit("docker version");
    const result = await invoke("goal node status", { cwd });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error: docker engine isn't running; please start it.");
  });
});

describe("isPathOrFilename", () => {
  it.each([
    ["approval.teal", true],
    ["./approval.teal", true],
    ["dir/file", true],
    ["/abs/path", true],
    ["~/file.txt", true],
    ["my-file_1.v2.json", true],
    ["-o", false],
    ["account", false],
    ["1000", false],
    ["--out=file", false],
    ["noext.", false],
    [".hidden", false],
  ])("%s -> %s", (arg, expected) => {
    expect(isPathOrFilename(arg)).toBe(expected);
  });
});

describe("preprocess / postProcess", () => {
  it("treats output flags as outputs even if the file exists", () => {
    const mount = path.join(cwd, "mount");
    mkdirSync(mount);
    writeFileSync(path.join(cwd, "existing.out"), "old");
    writeFileSync(path.join(cwd, "in.teal"), "in");

    const { inputFiles, outputFiles, command } = preprocessCommandArgs(
      ["clerk", "compile", path.join(cwd, "in.teal"), "--outfile", path.join(cwd, "existing.out")],
      mount,
      "/root/goal_mount/",
    );

    expect(command).toEqual(["clerk", "compile", "/root/goal_mount/in.teal", "--outfile", "/root/goal_mount/existing.out"]);
    expect(inputFiles).toEqual([path.join(cwd, "in.teal")]);
    expect(outputFiles).toEqual([path.join(cwd, "existing.out")]);
    expect(readFileSync(path.join(mount, "in.teal"), "utf-8")).toBe("in");

    writeFileSync(path.join(mount, "existing.out"), "new");
    postProcess(inputFiles, outputFiles, mount);
    expect(readFileSync(path.join(cwd, "existing.out"), "utf-8")).toBe("new");
    expect(existsSync(path.join(mount, "in.teal"))).toBe(false);
  });

  it("handles output files without an extension and regex characters in names", () => {
    const mount = path.join(cwd, "mount");
    mkdirSync(mount);
    const out = path.join(cwd, "out+file");
    writeFileSync(path.join(mount, "out+file"), "a");
    writeFileSync(path.join(mount, "out+file-2"), "b");
    writeFileSync(path.join(mount, "outtfile"), "c");

    postProcess([], [out], mount);

    expect(readFileSync(path.join(cwd, "out+file"), "utf-8")).toBe("a");
    expect(readFileSync(path.join(cwd, "out+file-2"), "utf-8")).toBe("b");
    expect(existsSync(path.join(cwd, "outtfile"))).toBe(false);
  });
});
