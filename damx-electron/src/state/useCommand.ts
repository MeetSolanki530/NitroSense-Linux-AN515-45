/**
 * Write primitives.
 *
 * Every control is optimistic-with-reconciliation, per the plan: apply the
 * change locally at once so the UI feels immediate, then re-read
 * get_all_settings and let the daemon's answer win. The UI therefore shows
 * what the hardware ACCEPTED, never merely what we asked for — which matters
 * because the daemon silently refuses values the driver rejects.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type CommandRunner = {
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
};

export function useCommand(refresh: () => Promise<void>): CommandRunner {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        // Reconcile even on success: the daemon may have clamped the value.
        await refresh();
        return true;
      } catch (e) {
        setError((e as Error).message);
        // Reconcile on failure too, so the control snaps back to reality
        // rather than sitting on a value the hardware never took.
        await refresh().catch(() => undefined);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { run, busy, error, clearError: () => setError(null) };
}

/**
 * Shows `pending` until the authoritative value catches up, then defers to it.
 * If the write failed, the caller calls reset() and the real value reappears.
 */
export function useOptimistic<T>(actual: T): {
  value: T;
  setPending: (v: T) => void;
  reset: () => void;
} {
  const [pending, setPending] = useState<T | null>(null);

  useEffect(() => {
    if (pending !== null && Object.is(actual, pending)) setPending(null);
  }, [actual, pending]);

  return {
    value: pending === null ? actual : pending,
    setPending: (v: T) => setPending(v),
    reset: () => setPending(null),
  };
}

/**
 * Trailing debounce for sliders. The transport allows only one in-flight
 * request, so dragging must not enqueue a write per pixel.
 */
export function useDebounced<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs = 150,
): (...args: A) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => latest.current(...args), delayMs);
    },
    [delayMs],
  );
}
