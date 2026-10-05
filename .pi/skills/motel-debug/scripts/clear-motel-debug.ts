#!/usr/bin/env bun

/**
 * Removes temporary motel debug blocks from JS/TS files under a path.
 *
 * Vendored from https://github.com/kitlangton/motel (skills/motel-debug/scripts/clear-motel-debug.ts).
 * A block is any run of lines between a `#region motel debug` marker and its
 * `#endregion motel debug`; both markers go too. Unmatched markers throw rather than
 * silently eating the rest of a file.
 *
 *   bun .pi/skills/motel-debug/scripts/clear-motel-debug.ts [path]
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const START_MARKER = "#region motel debug";
const END_MARKER = "#endregion motel debug";

const IGNORED_DIRECTORIES: Record<string, true> = {
  ".git": true,
  ".next": true,
  ".turbo": true,
  ".verify": true,
  build: true,
  coverage: true,
  dist: true,
  node_modules: true,
};

const SCANNED_EXTENSIONS: Record<string, true> = {
  ".cts": true,
  ".js": true,
  ".jsx": true,
  ".mts": true,
  ".ts": true,
  ".tsx": true,
};

const root = path.resolve(process.argv[2] ?? process.cwd());

const walk = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (IGNORED_DIRECTORIES[entry.name] === true) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (
      entry.isFile() &&
      SCANNED_EXTENSIONS[path.extname(entry.name)] === true
    ) {
      files.push(fullPath);
    }
  }

  return files;
};

const changedFiles: string[] = [];

for (const filePath of await walk(root)) {
  const source = await fs.readFile(filePath, "utf8");
  if (!source.includes(START_MARKER) && !source.includes(END_MARKER)) continue;

  const kept: string[] = [];
  let depth = 0;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.includes(START_MARKER)) {
      depth += 1;
    } else if (line.includes(END_MARKER)) {
      if (depth === 0) {
        throw new Error(`Unmatched ${END_MARKER} in ${filePath}:${index + 1}`);
      }
      depth -= 1;
    } else if (depth === 0) {
      kept.push(line);
    }
  }

  if (depth !== 0) {
    throw new Error(`Unmatched ${START_MARKER} in ${filePath}`);
  }

  await fs.writeFile(filePath, kept.join("\n"), "utf8");
  changedFiles.push(path.relative(root, filePath) || path.basename(filePath));
}

if (changedFiles.length === 0) {
  console.log(`No '${START_MARKER}' blocks found under ${root}`);
} else {
  console.log(
    `Removed motel debug blocks from ${changedFiles.length} file(s):`,
  );
  for (const file of changedFiles) console.log(`- ${file}`);
}
