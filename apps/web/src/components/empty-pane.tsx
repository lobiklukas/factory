import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * The pane a route shows when it has nothing to show.
 *
 * `visible` rather than a conditional at the call site: the route tree decides
 * which pane is mounted, so a wrapper that renders either the content or the
 * message keeps that decision in one place instead of at every call site.
 */
export const EmptyPane = ({
  title,
  detail,
  visible,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly visible: boolean;
  readonly children?: ReactNode;
}) => (
  <div className="flex min-w-0 flex-1 flex-col">
    {visible ? (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-[46ch] text-center">
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {detail}
          </p>
        </div>
      </div>
    ) : (
      <div className={cn("flex min-w-0 flex-1 flex-col")}>{children}</div>
    )}
  </div>
);
