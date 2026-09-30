# algokit-cli-ts

A TypeScript port of the [AlgoKit CLI](https://github.com/algorandfoundation/algokit-cli), limited to the
`localnet` and `goal` commands. It aims for feature parity with the Python implementation (v2.10.x): same
commands, options, generated LocalNet configuration, on-disk locations and console output.

## Usage

```sh
npm install
npm run build
node dist/index.js --help        # or `npm link` to get an `algokit` binary
```

```
algokit [-v] [--color/--no-color] <command>

  goal [--console] [--interactive] [GOAL_ARGS...]
  localnet config <docker|podman> [-f]
  localnet start [-n NAME] [-P CONFIG_DIR] [-d/--no-dev] [--force] [--check]
  localnet stop
  localnet reset [--update/--no-update] [-P CONFIG_DIR] [--check]
  localnet status [--check]
  localnet console
  localnet logs [-f/--follow] [--tail N]
```

It shares state with the Python CLI, so the two can be used interchangeably:

- config: `$XDG_CONFIG_HOME/algokit` (default `~/.config/algokit`, `%APPDATA%\algokit` on Windows). This holds
  the `sandbox*/` compose directories and `active-container-engine`.
- state: `$XDG_STATE_HOME/algokit` (`~/Library/Application Support/algokit` on macOS, `%LOCALAPPDATA%\algokit` on
  Windows). This holds `cli.log` (rotating debug log) and `last-localnet-version-check`.
- `ALGOKIT_LOCALNET_CONFIG_DIR` is honoured as the default for `--config-dir`.

## Layout

| Path | Python equivalent |
| --- | --- |
| `src/cli.ts` | `algokit/cli/__init__.py` (root group, `-v`, `--color`, error handling) |
| `src/commands/localnet.ts` | `algokit/cli/localnet.py` |
| `src/commands/goal.ts` | `algokit/cli/goal.py` |
| `src/core/sandbox.ts`, `src/core/sandbox-templates.ts` | `algokit/core/sandbox.py` |
| `src/core/goal.ts` | `algokit/core/goal.py` |
| `src/core/proc.ts` | `algokit/core/proc.py` |
| `src/core/log.ts` | `algokit/core/log_handlers.py` |

## Tests

```sh
npm test
```

The suite mocks `child_process.spawn` and `fetch`, so it needs neither Docker nor network access.
`test/parity.test.ts` checks the generated compose/config templates and the output of key scenarios against
the Python test-suite's approval files (copied into `test/fixtures/python`).

## Differences from the Python CLI

- Only `localnet` and `goal` exist. The top-level `config` command isn't ported, but `localnet config` is.
- There is no `explore` (top-level or `localnet explore`), no `localnet codespace`, and no Gitpod/Codespaces
  endpoint handling. The post-start hint points to `algokit goal` / `algokit localnet console` rather than
  `algokit explore`.
- `localnet status` points to `algokit localnet config` instead of `algokit config container-engine` to change the
  engine, since the latter doesn't exist here.
- `localnet logs`: in Python, `-f` is declared as the *off* switch of `--follow/-f`. Here `-f` means `--follow`.
- `localnet <subcommand> --help` works without a container engine. Click runs the engine checks before handling `--help`.
- `localnet config` requires the engine argument; there is no interactive picker.
- `goal`'s stdout and stderr are passed through unchanged. Python trims each line, adds a leading space and merges
  stderr into stdout.
- `HTTP Request: …` lines (health checks, Docker Hub version checks, status) are only shown with `-v`.
- The help text layout is commander's rather than click's.
