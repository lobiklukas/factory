/**
 * The Raise cap control (C23): it opens at the suggested cap and is unavailable while its call is in
 * flight; which caps it sends is `budget-view.test.ts`. The press in a real browser is `.pi/skills/verify-web/raise-cap.sh`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RaiseCap } from "./raise-cap";

const render = (props: Partial<Parameters<typeof RaiseCap>[0]> = {}) =>
  renderToStaticMarkup(
    <RaiseCap
      initial="0.02"
      spent={0.01}
      calling={false}
      onRaise={() => {}}
      {...props}
    />,
  );

describe("RaiseCap", () => {
  it("opens at the suggested cap, with a Raise cap button", () => {
    const markup = render();
    expect(markup).toContain('value="0.02"');
    expect(markup).toContain("Raise cap");
    expect(markup).not.toContain("data-raise-cap-invalid");
  });

  it("is busy and unavailable while its call is in flight", () => {
    const markup = render({ calling: true });
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-disabled="true"');
  });

  it("does not say a suggestion is wrong before anything was typed, even when the cap is unknown", () => {
    const markup = render({ initial: "" });
    expect(markup).not.toContain("data-raise-cap-invalid");
    expect(markup).toContain('aria-disabled="true"');
  });
});
