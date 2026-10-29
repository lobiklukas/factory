import { useCallback, useEffect, useState } from "react";

/**
 * Checkboxes that answer the click at once and settle on what the server says. A toggle writes over
 * RPC and re-reads, and a controlled checkbox bound straight to the re-read value would snap back
 * to its old state for the length of the round trip — a toggle that looks like it did nothing. The
 * pending value is shown until `actual` agrees with it, and dropped the moment the write fails, so a
 * refusal puts the box back where it was.
 */
export const useOptimisticToggles = (
  actual: Readonly<Record<string, boolean>>,
) => {
  const [pending, setPending] = useState<Readonly<Record<string, boolean>>>({});

  useEffect(() => {
    setPending((before) => {
      const after = Object.fromEntries(
        Object.entries(before).filter(([key, value]) => actual[key] !== value),
      );
      return Object.keys(after).length === Object.keys(before).length
        ? before
        : after;
    });
  }, [actual]);

  const checked = useCallback(
    (key: string, fallback: boolean): boolean => pending[key] ?? fallback,
    [pending],
  );
  const choose = useCallback((key: string, value: boolean) => {
    setPending((before) => ({ ...before, [key]: value }));
  }, []);
  const revert = useCallback((key: string) => {
    setPending((before) => {
      const { [key]: _dropped, ...rest } = before;
      return rest;
    });
  }, []);
  return { checked, choose, revert };
};
