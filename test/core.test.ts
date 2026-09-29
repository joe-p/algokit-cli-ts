import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ComposeFileStatus, ComposeSandbox, getAlgodNetworkTemplate } from "../src/core/sandbox.js";
import { extractVersionTriple, isMinimumVersion } from "../src/core/utils.js";
import { sandboxDir, writeLatestCompose } from "./support/fixtures.js";
import { invoke } from "./support/invoke.js";

describe("version helpers", () => {
  it("extracts a version triple", () => {
    expect(extractVersionTriple('{"version": "v2.10.0-gitpod.0"}')).toBe("2.10.0");
    expect(() => extractVersionTriple("v2.5-dev")).toThrow("Unable to parse version number");
  });

  it.each([
    ["2.5.0", "2.5.0", true],
    ["2.10.0", "2.5.0", true],
    ["2.4.9", "2.5.0", false],
    ["3.0.0", "2.5.0", true],
    ["1.0.6", "1.0.6", true],
  ])("isMinimumVersion(%s, %s) = %s", (system, minimum, expected) => {
    expect(isMinimumVersion(system, minimum)).toBe(expected);
  });
});

describe("compose file status", () => {
  it("is missing with no files", () => {
    expect(new ComposeSandbox().composeFileStatus()).toBe(ComposeFileStatus.MISSING);
  });

  it("is up to date regardless of DevMode", () => {
    writeLatestCompose();
    const sandbox = new ComposeSandbox();
    expect(sandbox.composeFileStatus()).toBe(ComposeFileStatus.UP_TO_DATE);
    sandbox.setAlgodDevMode(false);
    expect(sandbox.isAlgodDevMode()).toBe(false);
    expect(sandbox.composeFileStatus()).toBe(ComposeFileStatus.UP_TO_DATE);
  });

  it("is out of date when the template differs or is malformed", () => {
    writeLatestCompose();
    const templatePath = path.join(sandboxDir(), "algod_network_template.json");
    writeFileSync(templatePath, getAlgodNetworkTemplate().replace('"Stake": 20', '"Stake": 21'));
    expect(new ComposeSandbox().composeFileStatus()).toBe(ComposeFileStatus.OUT_OF_DATE);
    writeFileSync(templatePath, "{not json");
    expect(new ComposeSandbox().composeFileStatus()).toBe(ComposeFileStatus.OUT_OF_DATE);
  });
});

describe("root cli", () => {
  it("shows help", async () => {
    const result = await invoke("--help");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("goal");
    expect(result.output).toContain("localnet");
  });

  it("prefixes levels when colour is disabled and hides debug without -v", async () => {
    const { main } = await import("../src/cli.js");
    const { setConsoleWriters } = await import("../src/core/log.js");
    let output = "";
    const restore = setConsoleWriters({ stdout: (t) => void (output += t), stderr: (t) => void (output += t) });
    try {
      await main(["node", "algokit", "--no-color", "localnet", "logs"]);
    } finally {
      restore();
    }
    expect(output).not.toContain("DEBUG:");
  });
});
