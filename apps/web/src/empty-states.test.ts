import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No empty state sends an operator to a terminal (C9). The owner opened the dashboard and "couldn't
 * do anything": the boards page said to make a board with `factory board create`, which is no next
 * action for someone who opened a browser. Every pane that has nothing to show names a press in the
 * UI instead (`EmptyLink`, the checklist's links, the New board form).
 *
 * The case reads the source of every route, component and `lib` module and fails on a `factory <command>` in what
 * is left after comments are removed, so the copy a person reads cannot quietly gain one. A server's
 * own words (the checkout warning) are not in these files, and a test file may quote them.
 */
const SRC = dirname(fileURLToPath(import.meta.url));

/** The non-test sources of a directory with this extension, recursing into subdirectories. */
const sources = (directory: string, extension: string): ReadonlyArray<string> =>
  readdirSync(join(SRC, directory), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name), extension)
      : entry.name.endsWith(extension) && !entry.name.includes(".test.")
        ? [join(directory, entry.name)]
        : [],
  );

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Copy a person reads that quotes a command on purpose, each a known debt rather than a pass: the
 * repositories page's checkout-failure hint names `factory repo sync`, the CLI twin of its Save
 * button. Nothing else in `lib` may.
 */
const ALLOWED = new Set([join("lib", "repos-view.ts")]);

const CLI_INSTRUCTION =
  /\bfactory (board|repo|run|ls|status|session|approve|reset|fork|compact|spend)\b/;

describe("empty states", () => {
  // Much of the copy lives in the `lib/*-view.ts` modules (the checklist's own step text among
  // it), so those are scanned with the routes and components.
  const files = [
    ...sources("routes", ".tsx"),
    ...sources("components", ".tsx"),
    ...sources("lib", ".ts"),
  ].filter((file) => !ALLOWED.has(file));

  it("reads the routes and components it claims to", () => {
    expect(files).toContain(join("routes", "boards.index.tsx"));
    expect(files).toContain(join("components", "getting-started.tsx"));
    expect(files).toContain(join("lib", "first-run-view.ts"));
  });

  it.each(files)("%s gives no command to type in a terminal", (file) => {
    const copy = withoutComments(readFileSync(join(SRC, file), "utf8"));
    expect(CLI_INSTRUCTION.exec(copy)?.[0]).toBeUndefined();
  });

  it("the boards page's empty state offers the form, not the CLI", () => {
    const copy = readFileSync(join(SRC, "routes", "boards.index.tsx"), "utf8");
    expect(copy).toContain('<NewBoardLink where="empty" />');
    expect(copy).toContain("<GettingStarted");
  });
});
