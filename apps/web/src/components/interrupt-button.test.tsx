/**
 * The Interrupt control (C8): one press is one call. While the call is in flight the control says
 * so and drops a second press, and it stays focusable throughout (LOB-232's rule). The press in a
 * real browser — one `interruptSession` request, the run stopped — is
 * `.pi/skills/verify-web/interrupt.sh`.
 */
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InterruptButton } from "./interrupt-button";

/** The rendered `<button>`'s attributes, by name; a bare attribute reads as `""`. */
const buttonAttributes = (markup: string): ReadonlyMap<string, string> => {
  const tag = /<button\b([^>]*)>/.exec(markup)?.[1] ?? "";
  return new Map(
    [...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(
      ([, name = "", value = ""]) => [name, value] as const,
    ),
  );
};

const clickOf = (calling: boolean, onPress: () => void): (() => void) => {
  const tree: unknown = InterruptButton({ calling, onPress });
  if (!isValidElement<{ onClick: () => void }>(tree))
    throw new Error("InterruptButton rendered no element");
  return tree.props.onClick;
};

describe("InterruptButton", () => {
  it("is the labelled control the pane offers a busy run", () => {
    const attributes = buttonAttributes(
      renderToStaticMarkup(
        <InterruptButton calling={false} onPress={() => {}} />,
      ),
    );
    expect(attributes.get("aria-label")).toBe("Interrupt this run");
    expect(attributes.get("aria-disabled")).not.toBe("true");
    expect(attributes.get("data-interrupt-state")).toBe("idle");
  });

  it("stays focusable while its call is in flight, and says it is busy", () => {
    const attributes = buttonAttributes(
      renderToStaticMarkup(<InterruptButton calling onPress={() => {}} />),
    );
    expect(attributes.has("disabled")).toBe(false);
    expect(attributes.get("aria-disabled")).toBe("true");
    expect(attributes.get("aria-busy")).toBe("true");
    expect(attributes.get("data-interrupt-state")).toBe("calling");
  });

  it("calls once per press, and drops a press while the call is in flight", () => {
    const onPress = vi.fn();
    clickOf(false, onPress)();
    expect(onPress).toHaveBeenCalledTimes(1);
    clickOf(true, onPress)();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
