// The QR encoder is verified the only honest way: decode its own output with a real, independent QR
// decoder (jsQR) and check the round-trip. A wrong error-correction table, a misplaced module, or a
// bad mask would produce a matrix that does not decode, failing here rather than shipping a QR that
// will not scan. jsQR is a test-only devDependency; the CLI itself has no runtime dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQRImport from 'jsqr';
import { encode } from '../src/qr.ts';

const jsQR = ((jsQRImport as any).default ?? jsQRImport) as (
  data: Uint8ClampedArray, width: number, height: number,
) => { data: string } | null;

/** Rasterize a module matrix to an RGBA image (dark = black), with a quiet zone, for the decoder. */
function toImage(matrix: boolean[][], scale = 8, quiet = 4) {
  const n = matrix.length;
  const dim = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255); // white field
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      const y0 = (r + quiet) * scale, x0 = (c + quiet) * scale;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const idx = ((y0 + y) * dim + (x0 + x)) * 4;
          data[idx] = data[idx + 1] = data[idx + 2] = 0; // black module
          data[idx + 3] = 255;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

function roundTrips(input: string): string | null {
  const img = toImage(encode(input));
  return jsQR(img.data, img.width, img.height)?.data ?? null;
}

test('a short payload encodes to a scannable QR (version 1)', () => {
  const m = encode('HELLO');
  assert.equal(m.length, 21, 'version 1 is 21x21');
  assert.equal(roundTrips('HELLO'), 'HELLO');
});

test('a realistic base64url pairing code round-trips through a real decoder', () => {
  // Shape of an actual `cc pair-code` output: base64url of {v, addr, pk, s}. Lowercase + '-'/'_' force
  // byte mode.
  const code = 'eyJ2IjoxLCJhZGRyIjoidGNwOi8vMTAwLjEwMS4xMDIuMTAzOjc0NDMiLCJwayI6Ik1Db3dCUVlES' +
    'zJWd0F5RUFhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODktXyIsInMiOiJvbmUtdGltZS1zZWNyZXQtdmFsdWUifQ';
  assert.equal(roundTrips(code), code);
});

test('version selection and byte-mode round-trip hold across sizes (v1..v15)', () => {
  // Exercises the v9->v10 character-count width change (8 -> 16 bits) and v7+ version-info blocks.
  for (const len of [1, 14, 40, 100, 180, 260, 400]) {
    const s = Array.from({ length: len }, (_, i) => 'abcdefghijklmnop_-'[i % 18]).join('');
    assert.equal(roundTrips(s), s, `length ${len} must round-trip`);
  }
});

test('the three finder patterns are present at the corners', () => {
  const m = encode('finder-check');
  const n = m.length;
  const finderAt = (r0: number, c0: number) =>
    m[r0][c0] && m[r0 + 6][c0] && m[r0][c0 + 6] && !m[r0 + 1][c0 + 1] && m[r0 + 2][c0 + 2];
  assert.ok(finderAt(0, 0), 'top-left finder');
  assert.ok(finderAt(0, n - 7), 'top-right finder');
  assert.ok(finderAt(n - 7, 0), 'bottom-left finder');
});

test('an over-large payload is refused with a clear error, not a broken QR', () => {
  assert.throws(() => encode('x'.repeat(2000)), /too large/);
});
