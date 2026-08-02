/**
 * Pure parsing of persisted values, kept apart from secure-store.ts (which imports the native
 * keystore) so the defensive guards are testable without it. These guards matter: a corrupt seq entry
 * that seeded the counter below a real prior seq would defeat the anti-replay invariant, and a corrupt
 * device entry must not throw during hydration.
 */
import type { StoredDevice } from './secure-store';

/** Parse a persisted seq mark, clamping a missing, non-numeric, or negative value to 0. */
export function parseSeq(raw: string | null): number {
  const value = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Parse a stored device, returning null for a missing or unparseable entry rather than throwing. */
export function parseStoredDevice(raw: string | null): StoredDevice | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredDevice;
  } catch {
    return null;
  }
}
