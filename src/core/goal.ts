import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { getAppConfigDir } from "./conf.js";
import { ContainerEngine, getContainerEngine } from "./container-engine.js";
import { getLogger } from "./log.js";

const logger = getLogger("algokit.core.goal");

/** The goal_mount path inside the algod container (always a POSIX path). */
export function getVolumeMountPathDocker(): string {
  return "/root/goal_mount/";
}

export function getVolumeMountPathLocal(directoryName: string): string {
  const mountPath = path.join(getAppConfigDir(), directoryName, "goal_mount");
  if (getContainerEngine() === ContainerEngine.PODMAN) {
    // Pre create the directory to avoid permission issues
    mkdirSync(mountPath, { recursive: true });
  }
  return mountPath;
}

const FILENAME_PATTERN = /^[\p{L}\p{N}\p{Mn}\p{Pc}\-.]+\.[\p{L}\p{N}\p{Mn}\p{Pc}]+$/u;

/** Split a path into its parts, mirroring pathlib.PurePath.parts (root is its own part; "." and "" dropped). */
function pathParts(argument: string): string[] {
  const separators = process.platform === "win32" ? /[\\/]+/ : /\/+/;
  const parts: string[] = [];
  const root = path.parse(argument).root;
  if (root) parts.push(root);
  for (const part of argument.slice(root.length).split(separators)) {
    if (part !== "" && part !== ".") parts.push(part);
  }
  return parts;
}

export function isPathOrFilename(argument: string): boolean {
  const parts = pathParts(argument);
  return parts.length > 1 || (parts.length === 1 && FILENAME_PATTERN.test(parts[0] ?? ""));
}

function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

function deleteFileFromVolumeMount(filename: string, volumeMountPath: string): void {
  try {
    unlinkSync(path.join(volumeMountPath, filename));
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
  }
}

function listFilesInVolume(volumePath: string): string[] {
  if (!existsSync(volumePath) || !statSync(volumePath).isDirectory()) {
    logger.error(`${volumePath} does not exist or is not a directory.`);
    return [];
  }
  return readdirSync(volumePath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const OUTPUT_ARG_FLAGS = ["-o", "--outdir", "--outfile", "--out", "--result-out", "--lsig-out"];

export interface PreprocessedArgs {
  inputFiles: string[];
  outputFiles: string[];
  command: string[];
}

/**
 * Rewrite any file path arguments to point at the goal_mount directory inside the container,
 * copying input files into the local mount directory.
 */
export function preprocessCommandArgs(
  command: string[],
  volumeMountPathLocal: string,
  dockerMountPath: string,
): PreprocessedArgs {
  const inputFiles: string[] = [];
  const outputFiles: string[] = [];
  const result = [...command];
  try {
    result.forEach((arg, i) => {
      if (!isPathOrFilename(arg)) return;
      const absoluteArgPath = path.resolve(expandUser(arg));
      result[i] = path.posix.join(dockerMountPath, path.basename(absoluteArgPath));

      const fileExists = existsSync(absoluteArgPath);
      const isOutputArg = i > 0 && OUTPUT_ARG_FLAGS.includes(result[i - 1] ?? "");
      if (fileExists && !isOutputArg) {
        inputFiles.push(absoluteArgPath);
        mkdirSync(volumeMountPathLocal, { recursive: true });
        copyFileSync(absoluteArgPath, path.join(volumeMountPathLocal, path.basename(absoluteArgPath)));
      } else if (isOutputArg) {
        // it is an output file that doesn't exist yet
        outputFiles.push(absoluteArgPath);
      } else {
        throw new FileNotFoundError(`${arg} does not exist.`);
      }
    });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { inputFiles, outputFiles, command: result };
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Clean up copied input files and copy any output files out of the goal_mount directory. */
export function postProcess(inputFiles: string[], outputFiles: string[], volumeMountPathLocal: string): void {
  for (const inputFile of inputFiles) {
    deleteFileFromVolumeMount(path.basename(inputFile), volumeMountPathLocal);
  }

  const filesInVolumeMount = [...new Set(listFilesInVolume(volumeMountPathLocal))];
  for (const outputFile of outputFiles) {
    const ext = path.extname(outputFile);
    const stem = path.basename(outputFile, ext);

    // Copy outputs split into multiple files. For example `goal clerk split -i ./input.gtxn -o ./output.txn`
    // will produce a file (output-0.txn etc) for each transaction in the group being split.
    const pattern = new RegExp(`^(?:${escapeRegExp(stem)})(?:-[0-9]+)?${ext ? `(?:${escapeRegExp(ext)})` : ""}$`);

    for (const file of filesInVolumeMount) {
      const name = path.basename(file);
      if (!pattern.test(name)) continue;
      copyFileSync(path.join(volumeMountPathLocal, name), path.join(path.dirname(outputFile), name));
      deleteFileFromVolumeMount(name, volumeMountPathLocal);
    }
  }
}
