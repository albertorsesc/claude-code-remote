/**
 * The monotonic outbound seq counter that the ClientController pulls from. A seq must never repeat
 * across app launches, or a stale command could replay, so it is anchored to a persisted high-water
 * mark. Writing to secure storage on every send would be far too slow, so this reserves a block:
 * on start it jumps the persisted mark forward by RESERVE and hands out seqs within that block,
 * persisting a new reservation only when a block is exhausted.
 *
 * Invariant: the persisted value is always at least as large as every seq ever returned. So the next
 * launch starts strictly above the last one, even if the app was killed mid-block.
 */
/** How many seqs to reserve per disk write. A larger block means fewer writes but a bigger jump if
 *  the app is killed without sending them all (which only wastes numbers, never reuses one). */
const RESERVE = 256;

export interface SeqCounter {
  /** The next outbound seq. Strictly increasing, never reused across launches. */
  next: () => number;
}

/** Persistence of the high-water mark, injected so the counter logic is testable without the
 *  platform keystore. secure-store's loadSeq/saveSeq conform. */
export interface SeqStore {
  loadSeq(): Promise<number>;
  saveSeq(value: number): Promise<void>;
}

/** Build a seq counter seeded from the persisted high-water mark. */
export async function createSeqCounter(store: SeqStore): Promise<SeqCounter> {
  const start = await store.loadSeq();
  let current = start;
  let ceiling = start + RESERVE;
  await store.saveSeq(ceiling);

  return {
    next: () => {
      current += 1;
      if (current >= ceiling) {
        ceiling = current + RESERVE;
        // Fire-and-forget: the reservation is ahead of use, so a lost write only wastes numbers.
        void store.saveSeq(ceiling);
      }
      return current;
    },
  };
}
