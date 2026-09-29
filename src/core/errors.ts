/** A user-facing error; printed as `Error: <message>` and exits with code 1 (equivalent to click.ClickException). */
export class CliError extends Error {
  readonly exitCode: number = 1;
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** Exit the CLI with the given code without printing anything further (equivalent to click.exceptions.Exit). */
export class ExitError extends Error {
  constructor(readonly exitCode: number) {
    super(`Exit with code ${exitCode}`);
    this.name = "ExitError";
  }
}

/** Raised when an executable can't be found or started (equivalent to Python's OSError from Popen). */
export class CommandNotFoundError extends Error {
  constructor(
    readonly command: string,
    options?: { cause?: unknown },
  ) {
    super(`Command not found or not executable: ${command}`, options);
    this.name = "CommandNotFoundError";
  }
}

