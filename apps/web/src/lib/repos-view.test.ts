/**
 * The Repositories page's rules (LOB-262). What the server answers is proven where it is computed
 * (`packages/core`'s `listRepos`, the RPC router's test); the browser drive proves the page. These
 * are the cases a drive does not reach cheaply: a checkout that stopped being a repository, a form
 * typed with stray whitespace, a blank field that must not overwrite a row, a refusal with no body.
 */
import type { RepoSummary } from "@repo/domain/Session";
import { RepoSlug } from "@repo/domain/Session";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  EMPTY_REPO_FORM,
  notRunnableCount,
  registerInput,
  registerRefusal,
  runnability,
  sameDirectory,
  slugProblem,
  urlLabel,
} from "./repos-view";

const slug = Schema.decodeSync(RepoSlug);

const row = (over: Partial<RepoSummary> = {}): RepoSummary => ({
  repo: slug("acme/widgets"),
  url: "",
  defaultBaseRef: "main",
  registeredAt: "2026-10-28T00:00:00.000Z",
  localPathIsGit: false,
  hasFactoryConfig: false,
  ...over,
});

describe("runnability", () => {
  it("is runnable exactly for a checkout inside a git work tree", () => {
    expect(
      runnability(
        row({
          localPath: "/src/widgets",
          localPathIsGit: true,
          workTree: "/src/widgets",
        }),
      ),
    ).toEqual({ runnable: true });
  });

  it("flags a repo registered with no checkout, with the reason and the fix", () => {
    const state = runnability(row());
    expect(state).toMatchObject({ runnable: false, cause: "no_checkout" });
    if (state.runnable) return;
    expect(state.reason).toContain("No local checkout");
    expect(state.reason).toContain("no worktree is cut");
    expect(state.fix).toContain("local path");
  });

  it("does not take a clone URL for a checkout", () => {
    const state = runnability(row({ url: "https://github.com/acme/widgets" }));
    expect(state).toMatchObject({ runnable: false, cause: "no_checkout" });
  });

  it("flags a checkout that is no longer a work tree, naming the path", () => {
    const state = runnability(
      row({ localPath: "/gone/widgets", localPathIsGit: false }),
    );
    expect(state).toMatchObject({ runnable: false, cause: "not_a_work_tree" });
    if (state.runnable) return;
    expect(state.reason).toContain("/gone/widgets");
    expect(state.fix).toContain("git checkout");
  });

  it("counts the repos that cannot run", () => {
    const good = row({
      repo: slug("acme/good"),
      localPath: "/g",
      localPathIsGit: true,
    });
    expect(notRunnableCount([])).toBe(0);
    expect(notRunnableCount([good])).toBe(0);
    expect(
      notRunnableCount([
        good,
        row({ repo: slug("acme/none") }),
        row({ repo: slug("acme/moved"), localPath: "/m" }),
      ]),
    ).toBe(2);
  });
});

describe("slugProblem", () => {
  it("accepts owner/name and tolerates surrounding whitespace", () => {
    expect(slugProblem("acme/widgets")).toBeUndefined();
    expect(slugProblem("  acme/wid.get_s-2\n")).toBeUndefined();
  });

  it.each(["", "   ", "widgets", "Acme/Widgets", "acme/", "acme/a/b", "a b/c"])(
    "refuses %j",
    (value) => {
      expect(slugProblem(value)).toBeDefined();
    },
  );

  it("quotes the refused slug and states the rule", () => {
    const problem = slugProblem("Acme/Widgets");
    expect(problem).toContain('"Acme/Widgets"');
    expect(problem).toContain("owner/name");
    expect(problem).toContain("lowercase");
  });
});

describe("registerInput", () => {
  it("leaves blank fields out so the server keeps the row's values", () => {
    const parsed = registerInput({ ...EMPTY_REPO_FORM, repo: "acme/widgets" });
    expect(parsed).toEqual({ ok: true, input: { repo: "acme/widgets" } });
    if (parsed.ok) {
      expect(Object.keys(parsed.input)).toEqual(["repo"]);
    }
  });

  it("trims every field, because a pasted path carries its newline", () => {
    expect(
      registerInput({
        repo: " acme/widgets ",
        localPath: "/src/widgets\n",
        defaultBaseRef: " develop ",
        url: " https://github.com/acme/widgets.git ",
      }),
    ).toEqual({
      ok: true,
      input: {
        repo: "acme/widgets",
        localPath: "/src/widgets",
        defaultBaseRef: "develop",
        url: "https://github.com/acme/widgets.git",
      },
    });
  });

  it("treats whitespace alone as blank", () => {
    const parsed = registerInput({
      repo: "acme/widgets",
      localPath: "   ",
      defaultBaseRef: "\t",
      url: "",
    });
    expect(parsed).toEqual({ ok: true, input: { repo: "acme/widgets" } });
  });

  it("stops at a bad slug with its problem and sends nothing", () => {
    const parsed = registerInput({ ...EMPTY_REPO_FORM, repo: "Widgets" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toContain('"Widgets"');
  });

  it("leaves a relative path for the server to refuse in its own words", () => {
    expect(
      registerInput({
        ...EMPTY_REPO_FORM,
        repo: "acme/widgets",
        localPath: "relative/dir",
      }),
    ).toMatchObject({ ok: true, input: { localPath: "relative/dir" } });
  });
});

describe("registerRefusal", () => {
  it("shows the server's message verbatim with its tag", () => {
    const message = "localPath /tmp/x is not a git work tree";
    expect(
      registerRefusal({ _tag: "SessionError", message }, "fallback"),
    ).toEqual({ tag: "SessionError", message });
  });

  it("falls back to the cause's text for an untyped failure or an empty message", () => {
    expect(registerRefusal(undefined, "connection refused")).toEqual({
      tag: "Unknown",
      message: "connection refused",
    });
    expect(registerRefusal({ _tag: "SessionError", message: "" }, "x")).toEqual(
      {
        tag: "SessionError",
        message: "x",
      },
    );
  });
});

describe("urlLabel", () => {
  it("says so for a repo nobody gave a clone URL", () => {
    expect(urlLabel("")).toBe("no clone URL");
    expect(urlLabel("https://x/y.git")).toBe("https://x/y.git");
  });
});

describe("sameDirectory", () => {
  it("treats a trailing slash as the same directory", () => {
    expect(sameDirectory("/src/widgets", "/src/widgets/")).toBe(true);
    expect(sameDirectory("/src/widgets/", "/src/widgets")).toBe(true);
  });

  it("is quiet when there is no work tree to compare", () => {
    expect(sameDirectory(undefined, "/src/widgets")).toBe(true);
    expect(sameDirectory(undefined, undefined)).toBe(true);
  });

  it("names a different root: a package inside a repository", () => {
    expect(sameDirectory("/src/mono", "/src/mono/packages/a")).toBe(false);
  });
});
