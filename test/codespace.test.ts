import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "./support/invoke.js";
import { procMock } from "./support/proc-mock.js";

const prompts = vi.hoisted(() => ({
  confirm: vi.fn<(message: string, options?: { default?: boolean }) => Promise<boolean>>(),
  select: vi.fn(),
}));
vi.mock("../src/core/prompts.js", () => prompts);

// skip the provisioning waits
vi.mock("../src/core/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/core/utils.js")>();
  return { ...original, sleepSeconds: async () => {}, runWithAnimation: <T>(fn: () => Promise<T>) => fn() };
});

const AUTH_OK = ["Logged in to github.com account someone (keyring)", "- Token scopes: 'codespace', 'repo'"];

beforeEach(() => {
  prompts.confirm.mockReset().mockResolvedValue(true);
});

describe("localnet codespace", () => {
  it("creates a codespace, forwards ports and deletes it afterwards", async () => {
    procMock.setOutput("gh auth status", AUTH_OK);
    procMock.setOutput("gh codespace list", ["algokit-localnet_1\tAvailable", "other\tAvailable"]);
    procMock.setOutput("gh codespace list --json", ['[{"displayName":"sandbox","state":"Available","name":"cs-1"}]']);

    const result = await invoke("localnet codespace -n sandbox -a 14001 -k 14002 -i 18980 -t 30");

    expect(result.exitCode).toBe(0);
    const commands = procMock.calls.map((call) => call.command.join(" "));
    expect(commands).toContain("gh codespace delete --codespace algokit-localnet_1 --force");
    expect(commands).not.toContain("gh codespace delete --codespace other --force");
    expect(commands).toContain(
      "gh codespace create --repo algorandfoundation/algokit-base-template --display-name sandbox " +
        "--machine basicLinux32gb --idle-timeout 35m",
    );
    expect(commands).toContain(// gh expects <remote-port>:<local-port>
      "gh codespace ports forward --codespace cs-1 4001:14001 4002:14002 8980:18980");
    expect(commands.at(-1)).toBe("gh codespace delete --codespace cs-1 --force");
    expect(result.output).toContain("Port forwarding successful.\nLocalNet started in GitHub Codespace\nExiting...");
  });

  it("logs in when the codespace scope is missing", async () => {
    procMock.setOutput("gh auth status", ["Logged in to github.com", "- Token scopes: 'repo'"]);
    procMock.setOutput("gh codespace list --json", ['[{"displayName":"sandbox","state":"Available","name":"sandbox"}]']);

    const result = await invoke("localnet codespace -n sandbox --force");

    expect(result.output).toContain(
      "ERROR: Required 'codespace' scope is missing. Please ensure you have the 'codespace' scope by running " +
        "`gh auth refresh-token -s codespace`.",
    );
    expect(result.output).toContain("Logged in to GitHub Codespace");
    // authentication status is cached, so listing is skipped (matching Python)
    expect(procMock.calls.map((c) => c.command.join(" "))).not.toContain("gh codespace list");
  });

  it("retries port forwarding then gives up", async () => {
    procMock.setOutput("gh auth status", AUTH_OK);
    procMock.setOutput("gh codespace list", []);
    procMock.setOutput("gh codespace list --json", ['[{"displayName":"x","state":"Available","name":"x"}]']);
    procMock.shouldBadExit("gh codespace ports forward");

    const result = await invoke("localnet codespace -n x --force");

    expect(procMock.calls.filter((c) => c.command.join(" ").startsWith("gh codespace ports forward"))).toHaveLength(3);
    expect(result.output).toContain("ERROR: Port forwarding failed! Make sure you are not already running");
    expect(procMock.calls.at(-1)?.command.join(" ")).toBe("gh codespace delete --codespace x --force");
  });

  it("validates the timeout", async () => {
    const result = await invoke("localnet codespace -t 500");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Timeout must be between 1 and 240 minutes.");
  });

  it("validates the machine type", async () => {
    const result = await invoke("localnet codespace -m huge");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Allowed choices are basicLinux32gb");
  });
});
