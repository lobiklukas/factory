import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const SKILLS = path.join(REPO_ROOT, ".pi/skills");

/** The workarounds the issue removed, as the acceptance grep spells them. */
const WORKAROUNDS = ["resolveSync", "apps/api/node_modules"] as const;

/** Every file under `.pi/skills`, as paths relative to the repo root. */
const skillFiles = (dir: string = SKILLS): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : skillFiles(full);
    }
    return entry.isFile() ? [path.relative(REPO_ROOT, full)] : [];
  });

const read = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

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
    const offenders = skillFiles().flatMap((file) => {
      const text = read(file);
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
        .flatMap((file) => repoImports(read(file))),
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
