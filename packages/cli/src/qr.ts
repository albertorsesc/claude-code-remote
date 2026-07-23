/**
 * A dependency-free QR Code encoder, byte mode, error-correction level M, versions 1 through 15.
 *
 * It exists for one job: rendering the out-of-band pairing payload (the same base64url code
 * `cc pair-code` prints) as a QR a phone camera can scan. base64url uses lowercase and `_`, which are
 * outside QR's alphanumeric charset, so byte mode is required. Level M (about 15% recovery) is a good
 * default for a code scanned off a screen in varied light.
 *
 * Implemented against ISO/IEC 18004. It is verified the only way an encoder honestly can, by decoding
 * its own output with a real QR decoder and checking the round-trip (see tests/qr.test.ts), so a wrong
 * table or a misplaced module fails the build rather than shipping a QR that will not scan.
 *
 * `encode(text)` returns the module matrix as boolean rows (true = dark). Rendering is separate.
 */
import { Buffer } from 'node:buffer';

// --- GF(256) arithmetic (primitive polynomial 0x11D, generator 2) --------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial of the given degree: product of (x - alpha^i), leading coefficient first. */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon EC codewords for one data block: the remainder of data*x^ecLen divided by the generator. */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = data.concat(new Array(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
  }
  return res.slice(data.length);
}

// --- per-version, level-M error-correction block structure ---------------------------------------
// [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]. From the ISO 18004 tables.
type EcSpec = [number, [number, number][]];
const EC_M: Record<number, EcSpec> = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
  11: [30, [[1, 50], [4, 51]]],
  12: [22, [[6, 36], [2, 37]]],
  13: [22, [[8, 37], [1, 38]]],
  14: [24, [[4, 40], [5, 41]]],
  15: [24, [[5, 41], [5, 42]]],
};
// Alignment-pattern center coordinates per version (empty for v1).
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38],
  8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58],
  13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
};

const dataCodewords = (v: number): number => EC_M[v][1].reduce((s, [n, d]) => s + n * d, 0);
/** Character-count indicator width for byte mode: 8 bits for v1-9, 16 for v10+. */
const countBits = (v: number): number => (v <= 9 ? 8 : 16);

/** Smallest supported version whose level-M capacity holds `byteLen` bytes of byte-mode data. */
function pickVersion(byteLen: number): number {
  for (let v = 1; v <= 15; v++) {
    const cap = dataCodewords(v) * 8;
    const need = 4 + countBits(v) + byteLen * 8; // mode + count + data
    if (need <= cap) return v;
  }
  throw new Error(`pairing payload too large for a version-15 QR (${byteLen} bytes)`);
}

// --- bit stream ----------------------------------------------------------------------------------
class BitBuffer {
  bits: number[] = [];
  put(value: number, len: number) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
}

/** Encode bytes into the final, interleaved codeword sequence for `version` at level M. */
function makeCodewords(bytes: number[], version: number): number[] {
  const totalData = dataCodewords(version);
  const bb = new BitBuffer();
  bb.put(0b0100, 4); // byte mode
  bb.put(bytes.length, countBits(version));
  for (const b of bytes) bb.put(b, 8);
  // Terminator (up to 4 bits) without overshooting capacity.
  const cap = totalData * 8;
  for (let i = 0; i < 4 && bb.bits.length < cap; i++) bb.bits.push(0);
  // Pad to a byte boundary.
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);
  // Pack into codewords.
  const dataCw: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bb.bits[i + j];
    dataCw.push(b);
  }
  // Pad codewords: alternate 0xEC / 0x11.
  const pads = [0xec, 0x11];
  for (let i = 0; dataCw.length < totalData; i++) dataCw.push(pads[i % 2]);

  // Split into blocks, compute EC per block.
  const [ecLen, groups] = EC_M[version];
  const blocks: { data: number[]; ec: number[] }[] = [];
  let pos = 0;
  for (const [count, dpb] of groups) {
    for (let i = 0; i < count; i++) {
      const data = dataCw.slice(pos, pos + dpb);
      pos += dpb;
      blocks.push({ data, ec: rsEncode(data, ecLen) });
    }
  }
  // Interleave data codewords column-wise, then EC codewords column-wise.
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// --- matrix construction -------------------------------------------------------------------------
type Grid = { size: number; mod: (Int8Array)[]; fn: (Uint8Array)[] }; // mod: 1 dark / 0 light / -1 unset; fn: 1 = function module

function newGrid(version: number): Grid {
  const size = version * 4 + 17;
  const mod = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const fn = Array.from({ length: size }, () => new Uint8Array(size));
  return { size, mod, fn };
}
function set(g: Grid, r: number, c: number, dark: boolean, isFn: boolean) {
  g.mod[r][c] = dark ? 1 : 0;
  if (isFn) g.fn[r][c] = 1;
}

function placeFinder(g: Grid, r: number, c: number) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= g.size || cc < 0 || cc >= g.size) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      set(g, rr, cc, dark, true);
    }
  }
}

function placeFunctionPatterns(g: Grid, version: number) {
  // Finder patterns + separators (the separators are the light border drawn by placeFinder's -1..7 ring).
  placeFinder(g, 0, 0);
  placeFinder(g, 0, g.size - 7);
  placeFinder(g, g.size - 7, 0);
  // Timing patterns.
  for (let i = 8; i < g.size - 8; i++) {
    const dark = i % 2 === 0;
    set(g, 6, i, dark, true);
    set(g, i, 6, dark, true);
  }
  // Alignment patterns: every center-pair combination except the three that coincide with the finder
  // patterns. Centers that fall on the timing lines (like (6, 22)) ARE placed and override the timing
  // there; only the finder corners are skipped. (Skipping on "any function module present" was wrong:
  // it dropped the timing-line alignment patterns that versions 7+ require.)
  const centers = ALIGN[version];
  const last = centers[centers.length - 1];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          set(g, r + dr, c + dc, dark, true);
        }
      }
    }
  }
  // Dark module.
  set(g, g.size - 8, 8, true, true);
  // Reserve format-info areas (filled later; mark as function so data skips them).
  for (let i = 0; i < 9; i++) {
    if (!g.fn[8][i]) set(g, 8, i, false, true);
    if (!g.fn[i][8]) set(g, i, 8, false, true);
  }
  for (let i = 0; i < 8; i++) {
    if (!g.fn[8][g.size - 1 - i]) set(g, 8, g.size - 1 - i, false, true);
    if (!g.fn[g.size - 1 - i][8]) set(g, g.size - 1 - i, 8, false, true);
  }
  // Reserve version-info areas (v7+).
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        set(g, i, g.size - 11 + j, false, true);
        set(g, g.size - 11 + j, i, false, true);
      }
    }
  }
}

function placeData(g: Grid, codewords: number[]) {
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let bit = 0;
  let upward = true;
  for (let col = g.size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < g.size; i++) {
      const row = upward ? g.size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (g.fn[row][cc]) continue;
        g.mod[row][cc] = bit < bits.length ? bits[bit] : 0;
        bit++;
      }
    }
    upward = !upward;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(g: Grid, maskIdx: number): Grid {
  const out: Grid = { size: g.size, mod: g.mod.map((row) => Int8Array.from(row)), fn: g.fn };
  const cond = MASKS[maskIdx];
  for (let r = 0; r < g.size; r++) {
    for (let c = 0; c < g.size; c++) {
      if (!g.fn[r][c] && cond(r, c)) out.mod[r][c] ^= 1;
    }
  }
  return out;
}

// 15-bit format info (level M = 0b00, mask 0..7), BCH-encoded and XORed with 0x5412.
function formatBits(maskIdx: number): number {
  const data = (0b00 << 3) | maskIdx;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10);
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function drawFormat(g: Grid, maskIdx: number) {
  const bits = formatBits(maskIdx);
  // The 15 bits are placed most-significant-first: position 0 in the sequence below carries bit 14.
  const get = (i: number) => (bits >> (14 - i)) & 1;
  // Copy 1: around the top-left finder.
  for (let i = 0; i <= 5; i++) g.mod[8][i] = get(i);
  g.mod[8][7] = get(6);
  g.mod[8][8] = get(7);
  g.mod[7][8] = get(8);
  for (let i = 9; i <= 14; i++) g.mod[14 - i][8] = get(i);
  // Copy 2: split across the other two finders.
  for (let i = 0; i <= 7; i++) g.mod[g.size - 1 - i][8] = get(i);
  for (let i = 8; i <= 14; i++) g.mod[8][g.size - 15 + i] = get(i);
  // The dark module is always dark; copy 2's bit 7 above lands on it, so restore it last.
  g.mod[g.size - 8][8] = 1;
}

// 18-bit version info (v7+): 6-bit version, BCH-encoded with 0x1F25.
function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >> i) & 1) rem ^= 0b1111100100101 << (i - 12);
  return (version << 12) | rem;
}

function drawVersion(g: Grid, version: number) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    g.mod[r][g.size - 11 + c] = b;
    g.mod[g.size - 11 + c][r] = b;
  }
}

// --- mask penalty scoring (ISO 18004 rules 1-4) --------------------------------------------------
function penalty(g: Grid): number {
  const n = g.size;
  const at = (r: number, c: number) => g.mod[r][c];
  let score = 0;
  // Rule 1: runs of 5+ same-color modules in rows and columns.
  for (let r = 0; r < n; r++) {
    for (const line of [true, false]) {
      let run = 1, prev = -1;
      for (let c = 0; c < n; c++) {
        const v = line ? at(r, c) : at(c, r);
        if (v === prev) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
        else { run = 1; prev = v; }
      }
    }
  }
  // Rule 2: 2x2 blocks of the same color.
  for (let r = 0; r < n - 1; r++)
    for (let c = 0; c < n - 1; c++)
      if (at(r, c) === at(r, c + 1) && at(r, c) === at(r + 1, c) && at(r, c) === at(r + 1, c + 1)) score += 3;
  // Rule 3: finder-like 1:1:3:1:1 patterns in rows and columns.
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= n - 11; c++) {
      for (const p of [p1, p2]) {
        let mh = true, mv = true;
        for (let k = 0; k < 11; k++) { if (at(r, c + k) !== p[k]) mh = false; if (at(c + k, r) !== p[k]) mv = false; }
        if (mh) score += 40;
        if (mv) score += 40;
      }
    }
  }
  // Rule 4: proportion of dark modules.
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (at(r, c)) dark++;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** Encode `text` (UTF-8) into a QR module matrix (true = dark). `forceMask` pins the mask pattern
 *  (0-7) instead of choosing the lowest-penalty one; it exists for deterministic tests. */
export function encode(text: string, forceMask?: number): boolean[][] {
  const bytes = [...Buffer.from(text, 'utf8')];
  const version = pickVersion(bytes.length);
  const codewords = makeCodewords(bytes, version);

  const base = newGrid(version);
  placeFunctionPatterns(base, version);
  placeData(base, codewords);

  const tryMask = (m: number): Grid => {
    const g = applyMask(base, m);
    drawFormat(g, m);
    drawVersion(g, version);
    return g;
  };

  let best: Grid;
  if (forceMask !== undefined) {
    best = tryMask(forceMask);
  } else {
    // Try all 8 masks, keep the lowest-penalty one.
    best = tryMask(0);
    let bestScore = penalty(best);
    for (let m = 1; m < 8; m++) {
      const g = tryMask(m);
      const s = penalty(g);
      if (s < bestScore) { bestScore = s; best = g; }
    }
  }
  return best.mod.map((row) => Array.from(row, (v) => v === 1));
}

/**
 * Render a module matrix to a scannable string using half-block characters (two module rows per
 * text line), with the mandatory 4-module quiet zone.
 *
 * Colors are forced to true black-on-white with ANSI 24-bit codes, NOT left to the terminal theme.
 * A QR must be dark modules on a light field to scan; on the usual dark terminal, unforced blocks
 * would render light-on-dark (inverted) and most phone scanners would refuse it. With fg=black and
 * bg=white pinned, a half-block glyph paints the top module in black (fg) and the bottom in white
 * (bg), so the polarity is correct on any terminal.
 */
export function renderToTerminal(matrix: boolean[][]): string {
  const q = 4;
  const size = matrix.length + q * 2;
  const dark = (r: number, c: number) => {
    const rr = r - q, cc = c - q;
    return rr >= 0 && rr < matrix.length && cc >= 0 && cc < matrix.length && matrix[rr][cc];
  };
  const FG_BLACK_BG_WHITE = '\x1b[38;2;0;0;0;48;2;255;255;255m';
  const RESET = '\x1b[0m';
  const lines: string[] = [];
  for (let r = 0; r < size; r += 2) {
    let line = FG_BLACK_BG_WHITE;
    for (let c = 0; c < size; c++) {
      const top = dark(r, c);
      const bot = r + 1 < size ? dark(r + 1, c) : false;
      // fg paints the top half, bg the bottom half: '▀' = black top / white bottom.
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    lines.push(line + RESET);
  }
  return lines.join('\n');
}
