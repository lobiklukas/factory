import type { ReactNode } from "react";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * The pane a route shows when it has nothing to show.
 *
 * `visible` rather than a conditional at the call site: the route tree decides
 * which pane is mounted, so a wrapper that renders either the content or the
 * message keeps that decision in one place instead of at every call site.
 *
 * The copy in these panes is where the product is honest about what is missing,
 * and it is read by `drive.mjs`, so the title strings are asserted. Keep the
 * milestone name in the detail: a reader who wants to know when it arrives needs
 * the name, not a link to a file they cannot open from the browser.
 */
export const EmptyPane = ({
  title,
  detail,
  icon,
  visible,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly icon?: ReactNode;
  readonly visible: boolean;
  readonly children?: ReactNode;
}) => (
  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {visible ? (
      <Empty className="mx-auto max-w-[52ch] px-6">
        {icon === undefined ? null : (
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
        )}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
      </Empty>
    ) : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    )}
  </div>
);
