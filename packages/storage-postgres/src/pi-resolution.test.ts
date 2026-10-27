import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The `.pi` drivers import workspace packages directly, and the repo instructions name the Postgres
 * that actually answers on 5442 (LOB-236).
 *
 * Bun's isolated linker links a workspace package only into the packages that declare it, so a file
 * under `.pi/` resolves `@repo/*` from the root `node_modules`, which holds exactly what the root
 * `package.json` names. Before LOB-175 declared `@repo/core`, `@repo/harness` and
 * `@repo/storage-postgres` there, the drivers worked around it three ways: `Bun.resolveSync` from
 * `apps/api`, `bun -e "$(cat seed.ts)"` with `apps/api` as the working directory, and a copy of the
 * driver beside a symlink to `apps/api/node_modules`. Each of those runs the driver somewhere other
 * than where it lives, and each hides the fact that the root stopped declaring a package. So this
 * pins both halves: no workaround is left in `.pi/skills`, and every `@repo/*` package a driver
 * imports is one the root declares and links.
 *
 * The manifest scan only reads `@repo/*` names out of the root `package.json`, and a declared package
 * can still fail to resolve: the verify-api pr-once drive died before its first phase on
 * `@effect/platform-bun`, then on `@repo/harness` (LOB-214). So a stronger case asks Bun's own
 * resolver, from each driver's directory, for every bare import the driver makes (external packages
 * and subpaths too, not just `@repo/*`). Unlike the rest of this file it spawns a subprocess, so it
 * needs `bun` on `PATH`.
 *
 * The docs half: `AGENTS.md` and `docs/parallel-work.md` used to prescribe
 * `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` to reach the test database. On this machine
 * Docker Desktop publishes 5442, so a `docker exec` into Colima's `factory-postgres-1` created
 * databases on a server nothing connects to. The instructions now send agents to the port instead.
 *
 * What this cannot prove: that a driver passes. The drives themselves are the proof of that, and
 * they need a database, a browser and a terminal; the LOB-236 runs are under `.verify/evidence/`.
 *
 * It lives in `@repo/storage-postgres` for the same reason `mcp-pin.test.ts` does: a repo-level
 * claim that belongs to no package and needs no database to run.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The workarounds the issue removed, as the acceptance grep spells them. */
const WORKAROUNDS = ["resolveSync", "apps/api/node_modules"] as const;

const read = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

/**
 * Every file under `.pi/skills` that git tracks or would track (ignored ones excluded), as paths
 * relative to the repo root, with its text: listed and read once, while the file is collected.
 *
 * Two reasons it is not a walk inside a case (LOB-237). The cost is the first read of each file in
 * the worker, not the walk: warm, the 170 files here take ~10 ms; cold, the same reads took 60 ms to
 * 1.6 s on an idle-to-busy laptop, and a gate run beside other worktrees' gates once took over 5 s.
 * The first case used to be the first to open the non-source files, so it paid that cost inside its
 * budget: a synchronous body blocks vitest's timer, but the runner still compares the elapsed time
 * with the 5 s default when the body returns. Collection has no per-case budget, so every read is
 * paid there, once, and the cases below are left with in-memory string work. And the readdir walk
 * read what git ignores: the `.verify/` evidence a drive leaves under its skill (screenshots,
 * transcripts), which nobody commits, and whose text (a transcript of a grep, say) could name a
 * workaround.
 */
const SKILL_TEXTS: ReadonlyMap<string, string> = (() => {
  const listing = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ".pi/skills",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // `spawnSync` blocks the thread, so the bound belongs here, as in `unresolvedUnderBun` below.
      timeout: 30_000,
    },
  );
  if (listing.error !== undefined || listing.status !== 0) {
    throw new Error(
      `listing .pi/skills with git failed: ${listing.error?.message ?? listing.stderr}`,
    );
  }
  const files = [...new Set(listing.stdout.split("\0"))]
    .filter((file) => file !== "")
    // A tracked file deleted from the working tree is still in the index; it is no driver.
    .filter((file) => existsSync(path.join(REPO_ROOT, file)))
    .sort();
  return new Map(files.map((file) => [file, read(file)] as const));
})();

const skillFiles = (): ReadonlyArray<string> => [...SKILL_TEXTS.keys()];

/** A listed file's text, from the one read above. */
const skillText = (file: string): string => SKILL_TEXTS.get(file) ?? "";

/** The `@repo/<name>` packages a source text imports, statically or dynamically. */
const repoImports = (text: string): ReadonlyArray<string> =>
  Array.from(
    text.matchAll(/(?:from|import\()\s*["'](@repo\/[^/"']+)/g),
    (match) => match[1] ?? "",
  );

const SOURCE = /\.(?:ts|mts|mjs|js)$/;

describe(".pi drivers resolve workspace packages directly", () => {
  it("leaves no resolution workaround in .pi/skills", () => {
    // Mutation: put `Bun.resolveSync(specifier, path.join(ROOT, "apps/api"))` back into
    // `lib/seed-pr.ts`, or the `ln -s "$ROOT/apps/api/node_modules"` back into
    // `verify-api/verify-tool.sh`, and the file is listed here.
    // The premise: the scan covers both of those files, so an empty listing is a broken scan, not a
    // pass. Mutation: list `.pi/skill` (singular) in `SKILL_TEXTS` — this reads an empty set.
    expect(skillFiles()).toEqual(
      expect.arrayContaining([
        ".pi/skills/lib/seed-pr.ts",
        ".pi/skills/verify-api/verify-tool.sh",
      ]),
    );
    const offenders = skillFiles().flatMap((file) => {
      const text = skillText(file);
      return WORKAROUNDS.filter((needle) => text.includes(needle)).map(
        (needle) => `${file}: ${needle}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("runs the board seed by path, not as text evaluated from apps/api", () => {
    // Mutation: restore `spawnSync("bun", ["-e", await readFile(…seed.ts…)], { cwd: …apps/api })` in
    // the web drive — neither half of the old shape may come back.
    const drive = read(".pi/skills/verify-web/drive.mjs");
    expect(drive).toContain(
      `["run", path.join(ROOT, ".pi/skills/verify-board/seed.ts")]`,
    );
    expect(drive).not.toMatch(/cwd:\s*path\.join\(ROOT,\s*"apps\/api"\)/);
  });

  it("declares and links every @repo package a driver imports at the root", () => {
    // Mutation: drop `@repo/harness` from the root devDependencies, and `lib/seed-pr.ts` and
    // `verify-api/verify-tool.ts` are named here as importing a package `.pi/` cannot resolve.
    const pkg: { readonly devDependencies?: Record<string, string> } =
      JSON.parse(read("package.json"));
    const declared = new Set(Object.keys(pkg.devDependencies ?? {}));
    const imported = new Set(
      skillFiles()
        .filter((file) => SOURCE.test(file))
        .flatMap((file) => repoImports(skillText(file))),
    );
    // The premise: the drivers really do import workspace packages, so an empty set is a broken
    // scan, not a pass.
    expect([...imported].sort()).toEqual(
      expect.arrayContaining([
        "@repo/core",
        "@repo/harness",
        "@repo/storage-postgres",
      ]),
    );
    const undeclared = [...imported].filter((name) => !declared.has(name));
    expect(undeclared).toEqual([]);
    const unlinked = [...imported].filter(
      (name) =>
        !existsSync(path.join(REPO_ROOT, "node_modules", name, "package.json")),
    );
    expect(unlinked).toEqual([]);
  });
});

/**
 * Every non-relative module a source text imports, with its subpath: `import … from`, `export …
 * from` and a bare `import "x"` at the start of a statement, and `import("x")` anywhere. Anchoring
 * the static forms to a statement keeps prose such as `"forked from"` inside a string out of it.
 */
const bareImports = (text: string): ReadonlyArray<string> =>
  [
    ...text.matchAll(
      /^\s*(?:import|export)\b[^;"'`]*?\bfrom\s*(["'])([^"'\s]+)\1/gm,
    ),
    ...text.matchAll(/^\s*import\s*(["'])([^"'\s]+)\1/gm),
    ...text.matchAll(/\bimport\(\s*(["'])([^"'\s]+)\1/g),
  ]
    .map((match) => match[2] ?? "")
    .filter((specifier) => !/^(?:\.|\/|$)/.test(specifier));

/**
 * Asks Bun — the runtime every driver runs under — to resolve each `[file, specifier]` pair from
 * the file's own directory, and answers the pairs it could not resolve.
 */
const unresolvedUnderBun = (
  pairs: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<string> => {
  const script = `
    const path = require("node:path");
    const pairs = JSON.parse(await Bun.stdin.text());
    const failures = [];
    for (const [file, specifier] of pairs) {
      try {
        Bun.resolveSync(specifier, path.dirname(path.join(process.cwd(), file)));
      } catch {
        failures.push(file + ": " + specifier);
      }
    }
    console.log(JSON.stringify(failures));
  `;
  const result = spawnSync("bun", ["-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: JSON.stringify(pairs),
    // `spawnSync` blocks the thread, so the vitest timeout cannot fire: the bound belongs here.
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `resolving the drivers' imports under bun failed: ${result.error?.message ?? result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
};

describe(".pi drivers start: every module they import resolves under Bun (LOB-214)", () => {
  // The verify-api pr-once drive once died before its first phase with `Cannot find module
  // '@effect/platform-bun' from '.pi/skills/verify-api/pr-once.ts'`, and, once that was installed,
  // the same for `@repo/harness`. The case above only reads the root manifest for `@repo/*`; this
  // one asks the resolver the drive actually runs under, for every bare import — external packages
  // and `effect/…` / `@repo/domain/…` subpaths included — from the file that makes it.
  const pairs = skillFiles()
    .filter((file) => SOURCE.test(file))
    .flatMap((file) =>
      [...new Set(bareImports(skillText(file)))].map(
        (specifier) => [file, specifier] as const,
      ),
    );

  it("scans the imports that once stopped pr-once.ts", () => {
    // The premise: an empty or broken scan would make the next case pass vacuously.
    const prOnce = pairs
      .filter(([file]) => file === ".pi/skills/verify-api/pr-once.ts")
      .map(([, specifier]) => specifier);
    expect(prOnce).toEqual(
      expect.arrayContaining([
        "@effect/platform-bun",
        "@repo/core",
        "@repo/harness",
        "@repo/storage-postgres",
        "effect",
      ]),
    );
  });

  it(
    "resolves each one from the driver's own directory",
    { timeout: 60_000 },
    () => {
      // Mutation: drop `@repo/harness` or `@effect/platform-bun` from the root devDependencies and
      // reinstall (or move `node_modules/@effect/platform-bun` aside), and `pr-once.ts` is named
      // here with the module Bun cannot find — the error the drive printed.
      expect(unresolvedUnderBun(pairs)).toEqual([]);
    },
  );
});

describe("the repo instructions reach the test database over TCP", () => {
  const DOCS = ["AGENTS.md", "docs/parallel-work.md"] as const;

  it.each(DOCS)("%s does not prescribe the Colima socket", (doc) => {
    // Mutation: restore AGENTS.md's "use `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`".
    expect(read(doc)).not.toContain(".colima/default/docker.sock");
  });

  it.each(DOCS)("%s asks the port who answers on 5442", (doc) => {
    // Mutation: delete the `lsof` line, and the advice is back to assuming a Docker context.
    expect(read(doc)).toContain("lsof -nP -iTCP:5442 -sTCP:LISTEN");
  });

  it("docs/parallel-work.md creates per-worktree databases over TCP, not by docker exec", () => {
    // Mutation: restore `docker compose exec postgres createdb factory_<slug>` as the recipe.
    const text = read("docs/parallel-work.md");
    expect(text).toContain(
      "createdb -h localhost -p 5442 -U factory factory_<slug>",
    );
    expect(text).not.toContain("docker compose exec postgres createdb");
  });
});
