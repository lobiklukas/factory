/**
 * The getting-started guide names only commands the CLI defines (G1).
 *
 * `docs/getting-started.md` walks a person from a clone to a card in review, one `factory` command
 * per step. A guide that drifts is worse than none: a renamed flag turns a step into an error nobody
 * can tell from their own mistake. So this reads every `factory …` line in the guide's code blocks
 * and every inline `factory …` span in its prose, resolves each against the CLI's own `--help`
 * (the real parser, run once per subcommand path), and fails on a subcommand or a flag the CLI does
 * not define. `.pi/skills/verify-board/guide.sh` is the other half: it runs the guide's `sh walk`
 * blocks for real and reaches a card in review.
 *
 * It also checks the configuration table against `.env.example`, so a variable the guide tells an
 * operator to set is one the repository documents (and a typo is caught here, not by a webhook that
 * stays unarmed).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = join(ROOT, "apps/cli/src/index.ts");
const GUIDE = join(ROOT, "docs/getting-started.md");

/** One `factory …` invocation the guide shows, and where. */
type Invocation = {
  readonly line: number;
  readonly tokens: ReadonlyArray<string>;
};

/**
 * Split a shell-ish command into words: single and double quotes group, a backslash escapes, and
 * `$(…)`/`${…}` stay inside their word. It is not a shell, and only has to be as good as the
 * guide's own commands.
 */
const words = (text: string): ReadonlyArray<string> => {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let depth = 0;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else current += c;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      started = true;
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "$" && text[i + 1] === "(") {
      depth++;
      current += "$(";
      started = true;
      i++;
    } else if (c === ")" && depth > 0) {
      depth--;
      current += c;
    } else if (/\s/.test(c) && depth === 0) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
};

/**
 * Every `factory …` command in a markdown document: a line of a fenced block that starts with
 * `factory ` (continuation lines joined, a pipe or `&&` ends it), a `factory …` after `$(` or `|`
 * inside such a block, and an inline code span that starts with `factory `.
 */
const invocations = (markdown: string): ReadonlyArray<Invocation> => {
  const found: Invocation[] = [];
  const lines = markdown.split("\n");
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      let text = raw;
      let end = index;
      while (text.trimEnd().endsWith("\\") && end + 1 < lines.length) {
        end++;
        text = `${text.trimEnd().slice(0, -1)} ${lines[end] ?? ""}`;
      }
      // A `factory` word that starts a command: at the line's start, or after `$(`, `|`, `&&`, `;`,
      // `!`, a function body's `{`, or the keywords `then`, `do`, `if`, `else`.
      for (const match of text.matchAll(
        /(?:^|\$\(|\||&&|;|!|\{|\b(?:then|do|if|else))\s*factory\s+([^|;&)}]*)/g,
      )) {
        const tokens = words(match[1] ?? "");
        if (tokens.length > 0) found.push({ line: index + 1, tokens });
      }
      continue;
    }
    for (const match of raw.matchAll(/`factory\s+([^`]*)`/g)) {
      const tokens = words(match[1] ?? "");
      if (tokens.length > 0) found.push({ line: index + 1, tokens });
    }
  }
  return found;
};

/** What a command's `--help` says it takes. */
type Help = {
  readonly subcommands: ReadonlyArray<string>;
  readonly flags: ReadonlyArray<string>;
};

/** Parse the CLI's help text: the SUBCOMMANDS and FLAGS sections (not the GLOBAL FLAGS one). */
const parseHelp = (text: string): Help => {
  const section = (name: string): ReadonlyArray<string> => {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line === name);
    if (start < 0) return [];
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line !== "" && !line.startsWith(" ")) break;
      if (line.trim() !== "") body.push(line);
    }
    return body;
  };
  return {
    subcommands: section("SUBCOMMANDS").map(
      (line) => line.trim().split(/\s+/)[0] ?? "",
    ),
    flags: section("FLAGS").flatMap((line) =>
      [
        ...(line.trim().split(/\s{2,}/)[0] ?? "").matchAll(
          /--?[A-Za-z][\w-]*/g,
        ),
      ].map((m) => m[0]),
    ),
  };
};

const execFileAsync = promisify(execFile);
const helpCache = new Map<string, Promise<Help>>();

/** `factory <path> --help`, parsed. The CLI's own parser is the oracle, so a rename cannot slip by. */
const helpFor = (path: ReadonlyArray<string>): Promise<Help> => {
  const key = path.join(" ");
  const cached = helpCache.get(key);
  if (cached !== undefined) return cached;
  const result = execFileAsync("bun", [CLI, ...path, "--help"], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  }).then(({ stdout, stderr }) => parseHelp(`${stdout}\n${stderr}`));
  helpCache.set(key, result);
  return result;
};

/**
 * Why an invocation does not parse against the CLI, or `undefined`: an unknown subcommand, a command
 * that needs a subcommand and got none, or a flag the resolved command does not define.
 */
const problemWith = async (
  invocation: Invocation,
): Promise<string | undefined> => {
  const path: string[] = [];
  let help = await helpFor(path);
  let rest = invocation.tokens;
  while (help.subcommands.length > 0) {
    const next = rest[0];
    if (next === undefined || next.startsWith("-")) {
      return `\`factory ${path.join(" ")}\` needs a subcommand (${help.subcommands.join(", ")})`;
    }
    if (!help.subcommands.includes(next)) {
      return `\`factory ${[...path, next].join(" ")}\` is not a command (known: ${help.subcommands.join(", ")})`;
    }
    path.push(next);
    rest = rest.slice(1);
    help = await helpFor(path);
  }
  for (const token of rest) {
    if (!token.startsWith("-")) continue;
    const name = token.split("=")[0] ?? token;
    if (!help.flags.includes(name)) {
      return `\`factory ${path.join(" ")}\` has no flag ${name} (known: ${help.flags.join(", ")})`;
    }
  }
  return undefined;
};

/** The environment variables a markdown table's second column names, in backticks. */
const tableVariables = (
  markdown: string,
  heading: string,
): ReadonlyArray<string> => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${heading}`));
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cell = line.split("|")[2] ?? "";
    for (const match of cell.matchAll(/`([A-Z][A-Z0-9_]+)`/g))
      names.push(match[1] ?? "");
  }
  return names;
};

const guide = readFileSync(GUIDE, "utf8");

describe("docs/getting-started.md", () => {
  const shown = invocations(guide);

  it("shows the journey's commands, so the check below is not vacuous", () => {
    const commands = new Set(
      shown.map((item) => item.tokens.slice(0, 2).join(" ")),
    );
    for (const expected of [
      "repo add",
      "board create",
      "board add",
      "board start",
      "board move",
      "watch ",
      "doctor ",
    ]) {
      expect([...commands].some((c) => c.startsWith(expected.trim()))).toBe(
        true,
      );
    }
    expect(shown.length).toBeGreaterThan(25);
  });

  it("names only `factory` subcommands and flags the CLI defines", async () => {
    const problems = (
      await Promise.all(
        shown.map(async (item) => {
          const problem = await problemWith(item);
          return problem === undefined ? [] : [`line ${item.line}: ${problem}`];
        }),
      )
    ).flat();
    expect(problems).toEqual([]);
  }, 120_000);

  it("fails on a subcommand or a flag the CLI does not define", async () => {
    const bad = (text: string) => problemWith({ line: 1, tokens: words(text) });
    await expect(bad("board start --task t --idle")).resolves.toBeUndefined();
    await expect(bad("board launch --task t")).resolves.toContain(
      "is not a command",
    );
    await expect(bad("board start --task t --nope")).resolves.toContain(
      "--nope",
    );
    await expect(bad("board")).resolves.toContain("needs a subcommand");
    await expect(
      bad("repo add acme/x --path . --base-ref main"),
    ).resolves.toBeUndefined();
    await expect(bad("repo add acme/x --pat .")).resolves.toContain("--pat");
  }, 60_000);

  it("reads the commands out of blocks, continuations, substitutions and prose", () => {
    const text = [
      "Run `factory doctor --allow-faux` first.",
      "```sh",
      'TASK="$(factory board add --board "$B" --title "a b" \\',
      "  --body x | awk '{print $2}')\"",
      "echo not-a-command",
      'factory watch "$S"',
      "rev() { factory board show --task \"$T\" | awk '{print $2}'; }",
      "if x; then factory board ls; fi",
      "```",
    ].join("\n");
    expect(invocations(text)).toEqual([
      { line: 1, tokens: ["doctor", "--allow-faux"] },
      {
        line: 3,
        tokens: [
          "board",
          "add",
          "--board",
          "$B",
          "--title",
          "a b",
          "--body",
          "x",
        ],
      },
      { line: 6, tokens: ["watch", "$S"] },
      { line: 7, tokens: ["board", "show", "--task", "$T"] },
      { line: 8, tokens: ["board", "ls"] },
    ]);
  });

  it("names, in its configuration table, only variables .env.example documents", () => {
    const documented = readFileSync(join(ROOT, ".env.example"), "utf8");
    const named = tableVariables(guide, "Configuration table");
    expect(named.length).toBeGreaterThan(30);
    // The dashboard's and the CLI's own variables are documented in the README and the turbo
    // configs rather than in `.env.example`'s commented defaults.
    const elsewhere = new Set([
      "PORT",
      "VITE_PORT",
      "VITE_SERVER_URL",
      "FACTORY_API_URL",
    ]);
    const missing = named.filter(
      (name) =>
        !elsewhere.has(name) &&
        // An assignment line, commented out or not: a passing mention in another variable's
        // comment does not document it.
        !new RegExp(`^#?\\s*${name}=`, "m").test(documented),
    );
    expect(missing).toEqual([]);
  });
});
