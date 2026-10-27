/**
 * The session pane's PR link (LOB-65). The anchor itself is proven in a browser by
 * `.pi/skills/verify-web`; these are the values that must not become one, and the label a recorded
 * link reads as.
 */
import type { SessionSummary } from "@repo/domain/Session";
import { SessionId } from "@repo/domain/Session";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { foldSessionEvent, type SessionView } from "./atoms/session-atom";
import { prLink } from "./pr-link";

const PR_URL = "https://github.com/lobiklukas/factory/pull/7";

describe("prLink", () => {
  it("links the recorded URL verbatim and names the PR by its number", () => {
    expect(prLink(PR_URL)).toEqual({ href: PR_URL, label: "PR #7" });
  });

  it("keeps the recorded spelling rather than a normalized one", () => {
    // `new URL(...).href` would lowercase the host here; the drive compares the href with the
    // recorded string, so the anchor must carry the string the session recorded.
    const recorded = "https://GitHub.com/lobiklukas/factory/pull/12";
    expect(prLink(recorded)?.href).toBe(recorded);
  });

  it("says pull request when the URL names no number", () => {
    expect(prLink("https://forge.example/reviews/abc")).toEqual({
      href: "https://forge.example/reviews/abc",
      label: "Pull request",
    });
  });

  it("renders no link for a session with no PR", () => {
    expect(prLink(undefined)).toBeNull();
    expect(prLink("")).toBeNull();
  });

  it("renders no link for a value that is not an http(s) URL", () => {
    expect(prLink("javascript:alert(1)")).toBeNull();
    expect(prLink("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(prLink("not a url")).toBeNull();
  });

  it("reads the link a prOpened event folds into the summary", () => {
    // The pane reads `view.summary.prUrl`; this is the path a PR opened while the pane is attached
    // takes to it.
    const summary: SessionSummary = {
      id: Schema.decodeSync(SessionId)("ses_00000000000000000000000001"),
      title: "probe",
      status: "idle",
      mode: "live",
      createdAt: "2026-10-27T10:00:00.000Z",
    };
    const view: SessionView = {
      summary,
      entries: [],
      live: { busy: false, tools: [] },
      usage: { models: [], tools: [] },
      queued: [],
      tasks: [],
    };
    expect(prLink(view.summary.prUrl)).toBeNull();
    const after = foldSessionEvent(view, { _tag: "prOpened", prUrl: PR_URL });
    expect(prLink(after.summary.prUrl)?.href).toBe(PR_URL);
  });
});
