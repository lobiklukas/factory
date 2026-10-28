/**
 * The Open pull request button's markup (C7), as `compact-button.test.tsx` pins the Compact one's:
 * never a native `disabled` (a focused button that turns `disabled` drops focus to `body`), the
 * reason in the DOM for a blocked one, and a press swallowed while it is unavailable. The click
 * through to the forge is proven in a browser by `.pi/skills/verify-web` (`pr.sh`).
 */
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpenPullRequestButton } from "./open-pull-request";
import { Button } from "./ui/button";

type Props = Parameters<typeof OpenPullRequestButton>[0];
const props = (overrides: Partial<Props>): Props => ({
  state: "available",
  reasonId: "reason",
  reason: undefined,
  onPress: () => {},
  ...overrides,
});

const attributes = (markup: string): ReadonlyMap<string, string> => {
  const tag = /<button\b([^>]*)>/.exec(markup)?.[1] ?? "";
  return new Map(
    [...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(
      ([, name = "", value = ""]) => [name, value] as const,
    ),
  );
};

const render = (overrides: Partial<Props>) =>
  renderToStaticMarkup(<OpenPullRequestButton {...props(overrides)} />);

const clickOf = (overrides: Partial<Props>): (() => void) => {
  const tree: unknown = OpenPullRequestButton(props(overrides));
  if (!isValidElement<{ onClick: () => void; children?: ReactNode }>(tree))
    throw new Error("rendered no element");
  if (tree.type !== Button) {
    const inner = Children.toArray(tree.props.children).find(
      (child) => isValidElement(child) && child.type === Button,
    );
    if (!isValidElement<{ onClick: () => void }>(inner))
      throw new Error("rendered no button");
    return inner.props.onClick;
  }
  return tree.props.onClick;
};

const REASON =
  "the branch changes 4100 lines, over the cap of 2000, so no pull request was opened";

describe("OpenPullRequestButton", () => {
  it("is pressable when available, and says what it does", () => {
    const markup = render({});
    const attrs = attributes(markup);
    expect(attrs.get("data-open-pr")).toBe("available");
    expect(attrs.has("disabled")).toBe(false);
    expect(attrs.get("aria-disabled")).not.toBe("true");
    expect(markup).toContain("Open pull request");
  });

  it("offers a retry, not a fresh open, after a failure that may succeed next time", () => {
    const markup = render({ reason: "GitHub answered 502" });
    expect(markup).toContain("Retry pull request");
    expect(attributes(markup).get("aria-disabled")).not.toBe("true");
  });

  it("stays focusable but unavailable when blocked, with the reason as title and description", () => {
    const attrs = attributes(render({ state: "blocked", reason: REASON }));
    expect(attrs.get("data-open-pr")).toBe("blocked");
    expect(attrs.has("disabled")).toBe(false);
    expect(attrs.get("aria-disabled")).toBe("true");
    expect(attrs.get("title")).toBe(REASON);
    expect(attrs.get("aria-describedby")).toBe("reason");
  });

  it("is busy and unavailable while the call is in flight", () => {
    const attrs = attributes(render({ state: "opening" }));
    expect(attrs.get("aria-busy")).toBe("true");
    expect(attrs.get("aria-disabled")).toBe("true");
  });

  it("swallows a press while unavailable and admits one when available", () => {
    const onPress = vi.fn();
    clickOf({ state: "opening", onPress })();
    clickOf({ state: "blocked", reason: REASON, onPress })();
    expect(onPress).not.toHaveBeenCalled();
    clickOf({ onPress })();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
