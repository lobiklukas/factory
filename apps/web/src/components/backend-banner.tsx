import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { TriangleAlertIcon } from "lucide-react";
import { serverInfoAtom } from "@/lib/atoms/server-info-atom";
import { backendBanner, type BackendBanner } from "@/lib/server-info-view";

/**
 * The faux-backend banner (LOB-272): a persistent `role="alert"` across the top of every route, so
 * an operator reading a transcript can tell it came from the scripted model. It is not dismissible
 * on purpose: the point is that it is there the next time the page is looked at.
 */
export const BackendBannerView = ({
  banner,
}: {
  readonly banner: BackendBanner | null;
}) =>
  banner === null ? null : (
    <div
      role="alert"
      data-backend-banner
      className="flex shrink-0 items-start gap-2 border-b border-border bg-muted px-4 py-2 text-xs text-foreground"
    >
      <TriangleAlertIcon
        aria-hidden
        strokeWidth={1.75}
        className="mt-px size-3.5 shrink-0"
      />
      <span className="min-w-0 break-words">
        {banner.message}{" "}
        <span className="font-mono text-[10px] text-muted-foreground">
          {banner.reason}
        </span>
      </span>
    </div>
  );

/**
 * The banner for what the control plane answered; nothing until it has answered. A poll that fails
 * keeps the last answer (`AsyncResult.value` falls back to the previous success), as every other
 * polled view does, so a restart or a dropped request neither hides a faux banner nor re-announces it.
 */
export const BackendBannerSlot = () => {
  const result = useAtomValue(serverInfoAtom);
  return (
    <BackendBannerView
      banner={backendBanner(Option.getOrUndefined(AsyncResult.value(result)))}
    />
  );
};
