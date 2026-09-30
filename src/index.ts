#!/usr/bin/env node
import { main } from "./cli.js";

// exit quietly if our output is closed early (e.g. piped into `head`)
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

process.exitCode = await main();
