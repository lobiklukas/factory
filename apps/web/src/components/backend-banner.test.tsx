/** The faux banner's markup (LOB-272): an alert with the sentence, and nothing without a banner. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FAUX_BANNER } from "@/lib/server-info-view";
import { BackendBannerView } from "./backend-banner";

describe("BackendBannerView", () => {
  /** Mutation: render it as `status` (not announced) or drop the sentence. */
  it("renders the banner as an alert carrying the sentence and the reason", () => {
    const markup = renderToStaticMarkup(
      <BackendBannerView
        banner={{
          message: FAUX_BANNER,
          reason: "model backend: faux (selected by MODEL_BACKEND)",
        }}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("data-backend-banner");
    expect(markup).toContain("Scripted model (faux)");
    expect(markup).toContain("model backend: faux (selected by MODEL_BACKEND)");
  });

  it("renders nothing without a banner", () => {
    expect(renderToStaticMarkup(<BackendBannerView banner={null} />)).toBe("");
  });
});
