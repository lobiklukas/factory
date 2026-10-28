import { guideHref, GUIDE_STEPS, type GuideStepId } from "@/lib/guide-links";

/**
 * The step of the getting-started guide an empty pane is about (G1): a plain link out, in a new tab,
 * so the pane keeps its state. `data-guide-link` carries the step, which is what the drive asserts.
 */
export const GuideLink = ({ step }: { readonly step: GuideStepId }) => (
  <a
    href={guideHref(step)}
    target="_blank"
    rel="noreferrer noopener"
    data-guide-link={step}
    className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
  >
    {GUIDE_STEPS[step].label}
  </a>
);
