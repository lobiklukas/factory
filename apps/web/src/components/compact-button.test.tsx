/**
 * The Compact control's markup (LOB-232). Focus itself is proven in a browser by
 * `.pi/skills/verify-web` (a keyboard press, with `document.activeElement` sampled until the press
 * settles); these pin the attributes that decide it. A `<button disabled>` is the regression: the
 * press makes the control unavailable in the same tick, and a focused button that turns `disabled`
 * drops focus to `body`.
 */
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompactButton } from "./compact-button";

const BUSY = "Wait for this run to finish before compacting";

type Props = Parameters<typeof CompactButton>[0];
const props = (overrides: Partial<Props>): Props => ({
  blocked: null,
  running: false,
  calling: false,
  state: "idle",
  onPress: () => {},
  ...overrides,
});

/** The rendered `<button>`'s attributes, by name; a bare attribute reads as `""`. */
const buttonAttributes = (markup: string): ReadonlyMap<string, string> => {
  const tag = /<button\b([^>]*)>/.exec(markup)?.[1] ?? "";
  return new Map(
    [...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(
      ([, name = "", value = ""]) => [name, value] as const,
    ),
  );
};

const render = (overrides: Partial<Props>) =>
  renderToStaticMarkup(<CompactButton {...props(overrides)} />);

/** The `onClick` the control hands its button, read off the element tree it returns. */
const clickOf = (overrides: Partial<Props>): (() => void) => {
  const tree: unknown = CompactButton(props(overrides));
  if (!isValidElement<{ children: ReadonlyArray<unknown> }>(tree))
    throw new Error("CompactButton rendered no element");
  const button = tree.props.children[0];
  if (!isValidElement<{ onClick: () => void }>(button))
    throw new Error("CompactButton rendered no button");
  return button.props.onClick;
};

describe("CompactButton", () => {
  it("stays focusable while a press is running, and says it is unavailable", () => {
    const attributes = buttonAttributes(
      render({ running: true, calling: true, state: "requested" }),
    );
    expect(attributes.has("disabled")).toBe(false);
    expect(attributes.get("aria-disabled")).toBe("true");
    expect(attributes.get("tabindex")).toBe("0");
    expect(attributes.get("aria-busy")).toBe("true");
    expect(attributes.get("aria-label")).toBe("Compacting session");
  });

  it("stays focusable while the session is busy, with the reason as its description", () => {
    const markup = render({ blocked: BUSY });
    const attributes = buttonAttributes(markup);
    expect(attributes.has("disabled")).toBe(false);
    expect(attributes.get("aria-disabled")).toBe("true");
    expect(attributes.get("title")).toBe(BUSY);
    expect(attributes.get("aria-describedby")).toBe("compact-blocked");
    expect(markup).toContain(
      `<span id="compact-blocked" class="sr-only">${BUSY}</span>`,
    );
  });

  it("is available when nothing blocks it and nothing is running", () => {
    const markup = render({});
    const attributes = buttonAttributes(markup);
    expect(attributes.has("disabled")).toBe(false);
    expect(attributes.get("aria-disabled")).not.toBe("true");
    expect(attributes.has("aria-describedby")).toBe(false);
    expect(markup).not.toContain("compact-blocked");
  });

  it("ignores a press while it is unavailable and admits one when it is not", () => {
    const onPress = vi.fn();
    clickOf({ running: true, onPress })();
    clickOf({ blocked: BUSY, onPress })();
    expect(onPress).not.toHaveBeenCalled();
    clickOf({ onPress })();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
