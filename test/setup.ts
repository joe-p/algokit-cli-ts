import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, vi } from "vitest";

import { httpMock } from "./support/http-mock.js";
import { procMock } from "./support/proc-mock.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { procMock: mock } = await import("./support/proc-mock.js");
  return { ...original, spawn: mock.spawn.bind(mock) };
});

let tempRoot: string | undefined;
const originalEnv = { ...process.env };

beforeEach(async () => {
  tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "algokit-test-")));
  const configHome = path.join(tempRoot, "config");
  const stateHome = path.join(tempRoot, "state");
  mkdirSync(configHome);
  mkdirSync(stateHome);
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  delete process.env.NO_COLOR;
  delete process.env.ALGOKIT_LOCALNET_CONFIG_DIR;

  procMock.reset();
  httpMock.reset();
  vi.stubGlobal("fetch", httpMock.fetch);

  const { healthCheckTimings } = await import("../src/core/sandbox.js");
  healthCheckTimings.algodWait = 0.1;
  healthCheckTimings.indexerWait = 0.1;
  healthCheckTimings.healthTimeout = 0.05;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});
