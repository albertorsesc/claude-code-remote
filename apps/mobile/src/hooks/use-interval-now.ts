import { useEffect, useState } from 'react';

/**
 * A ticking `Date.now()` that updates on an interval, so a countdown or relative timestamp re-renders
 * without each row owning its own timer. Returns the current time in milliseconds. The interval is
 * cleared on unmount.
 */
export function useIntervalNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
