/** Rolling history for the sparklines. */
import { useEffect, useRef, useState } from 'react';

export function useHistory(value: number | null, length = 60): (number | null)[] {
  const [history, setHistory] = useState<(number | null)[]>([]);
  const last = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    // Only append on genuine updates, so re-renders do not inflate the series.
    if (last.current === value) return;
    last.current = value;
    setHistory((h) => {
      const next = [...h, value];
      return next.length > length ? next.slice(next.length - length) : next;
    });
  }, [value, length]);

  return history;
}
