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
 * The case reads the source of every route and component and fails on a `factory <command>` in what
 * is left after comments are removed, so the copy a person reads cannot quietly gain one. A server's
 * own words (the checkout warning) are not in these files, and a test file may quote them.
 */
const SRC = dirname(fileURLToPath(import.meta.url));

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(join(SRC, directory))
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .map((name) => join(directory, name));

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CLI_INSTRUCTION =
  /\bfactory (board|repo|run|ls|status|session|approve|reset|fork|compact|spend)\b/;

describe("empty states", () => {
  const files = [...sources("routes"), ...sources("components")];

  it("reads the routes and components it claims to", () => {
    expect(files).toContain(join("routes", "boards.index.tsx"));
    expect(files).toContain(join("components", "getting-started.tsx"));
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
