/** The no-checkout banner (LOB-263): it prints the server's sentence, and nothing without one. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckoutWarning } from "./checkout-warning";

describe("CheckoutWarning", () => {
  /** Mutation: render the banner whatever the warning — the empty case below prints markup. */
  it("renders the server's warning verbatim, as a status", () => {
    const warning =
      "repo a/b has no local checkout registered: register one with `factory repo add a/b --path <dir>`";
    const markup = renderToStaticMarkup(<CheckoutWarning warning={warning} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("data-checkout-warning");
    expect(markup).toContain("factory repo add a/b --path &lt;dir&gt;");
  });

  it("renders nothing when there is no warning", () => {
    expect(renderToStaticMarkup(<CheckoutWarning warning={undefined} />)).toBe(
      "",
    );
  });
});
