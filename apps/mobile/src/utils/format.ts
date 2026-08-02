/**
 * Small, pure formatting helpers for the UI. No React, no side effects, so they are trivial to reason
 * about and reuse across the countdown rows and the fleet cards.
 */

/** A millisecond duration as `M:SS`. Never negative; a passed deadline shows `0:00`. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** A past timestamp as a short relative label ("just now", "2m ago"), given the current time. */
export function formatRelative(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** The first non-empty line of a string, trimmed. Used to headline a multi-line command. */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return text.trim();
}

/** The first several characters of an id, for a compact display ("a1b2c3d4"). */
export function shortId(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(0, length);
}
