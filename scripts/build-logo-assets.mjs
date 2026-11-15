// Rebuild the app logo and icons from the official vector file (the striped D on page 1 of the brand font sheet).
// Usage: node scripts/build-logo-assets.mjs "<path to [THE DEPTH] FONT(LATIN CAPITAL&NUMBER).ai>"
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/build-logo-assets.mjs <brand .ai/.pdf>'); process.exit(1); }
const BOX = { x: 1595, y: 1756, w: 450, h: 193 }; // mark bounds on page 1, in points
const tmp = mkdtempSync(join(tmpdir(), 'logo-'));

/** The mark rendered from the vector at `width` px, as a coverage mask (0..1 per pixel). */
function mark(width) {
  const s = width / BOX.w; const pad = 2;
  const W = width + pad * 2; const H = Math.ceil(BOX.h * s) + pad * 2;
  const out = join(tmp, `m${width}`);
  execFileSync('pdftocairo', ['-png', '-transp', '-singlefile', '-f', '1', '-l', '1', '-r', String(72 * s),
    '-x', String(Math.round(BOX.x * s) - pad), '-y', String(Math.round(BOX.y * s) - pad), '-W', String(W), '-H', String(H), src, out]);
  const p = PNG.sync.read(readFileSync(out + '.png'));
  const a = new Float32Array(p.width * p.height);
  for (let i = 0; i < a.length; i++) a[i] = p.data[i * 4 + 3] / 255;
  return { w: p.width, h: p.height, a };
}

function canvas(w, h) { return new PNG({ width: w, height: h }); }
function put(png, x, y, rgb, alpha) {
  const i = (y * png.width + x) * 4; const da = png.data[i + 3] / 255; const oa = alpha + da * (1 - alpha);
  for (let k = 0; k < 3; k++) png.data[i + k] = oa ? Math.round((rgb[k] * alpha + png.data[i + k] * da * (1 - alpha)) / oa) : 0;
  png.data[i + 3] = Math.round(oa * 255);
}
/** Rounded square background (radius 0 = full square), antialiased by 4x4 supersampling. */
function background(png, rgb, radius) {
  const n = png.width;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let hit = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4; const py = y + (sy + 0.5) / 4;
      const cx = Math.min(Math.max(px, radius), n - radius); const cy = Math.min(Math.max(py, radius), n - radius);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= radius * radius) hit++;
    }
    if (hit) put(png, x, y, rgb, hit / 16);
  }
}
function stamp(png, m, ox, oy, rgb) {
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const a = m.a[y * m.w + x]; const X = ox + x; const Y = oy + y;
    if (a > 0 && X >= 0 && Y >= 0 && X < png.width && Y < png.height) put(png, X, Y, rgb, a);
  }
}
const save = (png, f) => { writeFileSync(f, PNG.sync.write(png)); console.log(f, png.width + 'x' + png.height); };

// Header/login/member-page marks: transparent background, 2x the old 479px width for sharp retina rendering.
const big = mark(958);
for (const [f, rgb] of [['src/assets/logo-mark.png', [0, 0, 0]], ['src/assets/logo-mark-white.png', [240, 240, 240]]]) {
  const png = canvas(big.w, big.h); stamp(png, big, 0, 0, rgb); save(png, f);
}
// Icons: [file, size, background, corner radius, mark width as a share of the icon]
const icons = [
  ['public/favicon-32.png', 32, [0, 0, 0], 6, 0.84],
  ['public/favicon-64.png', 64, [0, 0, 0], 12, 0.8],
  ['public/apple-touch-icon.png', 180, [0, 0, 0], 0, 0.6],
  ['public/member-icon-192.png', 192, [13, 13, 13], 0, 0.58],
  ['public/member-icon-512.png', 512, [13, 13, 13], 0, 0.58],
];
for (const [f, n, bg, r, share] of icons) {
  const png = canvas(n, n); background(png, bg, r);
  const m = mark(Math.round(n * share));
  stamp(png, m, Math.round((n - m.w) / 2), Math.round((n - m.h) / 2), [240, 240, 240]); save(png, f);
}
