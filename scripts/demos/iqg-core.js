// scripts/demos/iqg-core.js — port of image-quality-gate's analysis
// (app/services/preprocess.py + app/services/quality.py). Pure functions, no DOM.
// Verified: Pillow 12.3 resize byte-identical; OpenCV 5.0 scores within ~1e-11 relative.

export const DEFAULTS = Object.freeze({ blur_min: 140.0, bright_min: 20, bright_max: 235 }); // app/core/config.py
export const DOCKER_ENV = Object.freeze({ blur_min: 70.0, bright_min: 10, bright_max: 235 }); // .env.example (copied to .env by the Dockerfile)
export const RESIZE_MAX_DIM = 1600;
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

// preprocess.load_and_normalize: scale = min(1.0, max_dim / max(w, h)); int(w * scale)
export function targetSize(w, h, maxDim = RESIZE_MAX_DIM) {
  const scale = Math.min(1.0, maxDim / Math.max(w, h));
  return scale < 1.0 ? { w: Math.trunc(w * scale), h: Math.trunc(h * scale), resized: true } : { w, h, resized: false };
}

// ---- Pillow Image.resize(size, LANCZOS) for 8-bit RGB: libImaging/Resample.c ----
const PRECISION_BITS = 22; // 32 - 8 - 2
const sinc = (x) => { if (x === 0) return 1; x *= Math.PI; return Math.sin(x) / x; };
const lanczos = (x) => (-3 <= x && x < 3 ? sinc(x) * sinc(x / 3) : 0);
function coeffs(inSize, outSize) {
  const scale = inSize / outSize, filterscale = scale < 1 ? 1 : scale, support = 3 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1, ss = 1 / filterscale;
  const k = new Int32Array(outSize * ksize), bounds = new Int32Array(outSize * 2), tmp = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5); if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5); if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) { const w = lanczos((x + xmin - center + 0.5) * ss); tmp[x] = w; ww += w; }
    for (let x = 0; x < xmax; x++) {
      const v = ww !== 0 ? tmp[x] / ww : tmp[x];
      k[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin; bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, k, bounds };
}
const clip8 = (v) => (v >= (1 << PRECISION_BITS << 8) ? 255 : v <= 0 ? 0 : v >> PRECISION_BITS);

// src: pixels with `stride` bytes per pixel (3 = RGB, 4 = RGBA; alpha ignored like convert("RGB")).
// Returns RGB (stride 3) at ow × oh. Horizontal pass first, uint8 intermediate, as Pillow does.
export function resizeLanczos(src, w, h, stride, ow, oh) {
  const H = coeffs(w, ow), V = coeffs(h, oh), half = 1 << (PRECISION_BITS - 1);
  let img = src, iw = w, is = stride;
  if (ow !== w) {
    const yFirst = V.bounds[0], yLast = V.bounds[oh * 2 - 2] + V.bounds[oh * 2 - 1];
    for (let i = 0; i < oh; i++) V.bounds[i * 2] -= yFirst;
    const th = yLast - yFirst, tmp = new Uint8Array(ow * th * 3);
    for (let yy = 0; yy < th; yy++) {
      const row = (yy + yFirst) * w * stride;
      for (let xx = 0; xx < ow; xx++) {
        const xmin = H.bounds[xx * 2], xmax = H.bounds[xx * 2 + 1], o = xx * H.ksize;
        let s0 = half, s1 = half, s2 = half;
        for (let x = 0; x < xmax; x++) { const kv = H.k[o + x], p = row + (x + xmin) * stride; s0 += src[p] * kv; s1 += src[p + 1] * kv; s2 += src[p + 2] * kv; }
        const q = (yy * ow + xx) * 3; tmp[q] = clip8(s0); tmp[q + 1] = clip8(s1); tmp[q + 2] = clip8(s2);
      }
    }
    img = tmp; iw = ow; is = 3;
  }
  if (oh === h) return is === 3 ? img : toRGB(img, iw * h, is);
  const out = new Uint8Array(ow * oh * 3);
  for (let yy = 0; yy < oh; yy++) {
    const ymin = V.bounds[yy * 2], ymax = V.bounds[yy * 2 + 1], o = yy * V.ksize;
    for (let xx = 0; xx < iw; xx++) {
      let s0 = half, s1 = half, s2 = half;
      for (let y = 0; y < ymax; y++) { const kv = V.k[o + y], p = ((y + ymin) * iw + xx) * is; s0 += img[p] * kv; s1 += img[p + 1] * kv; s2 += img[p + 2] * kv; }
      const q = (yy * iw + xx) * 3; out[q] = clip8(s0); out[q + 1] = clip8(s1); out[q + 2] = clip8(s2);
    }
  }
  return out;
}
function toRGB(src, n, stride) { const o = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { o[i * 3] = src[i * stride]; o[i * 3 + 1] = src[i * stride + 1]; o[i * 3 + 2] = src[i * stride + 2]; } return o; }

// cv2.cvtColor(..., COLOR_BGR2GRAY) for 8-bit input. OpenCV 5.x: 15-bit fixed point.
// (OpenCV 4.x used [4899, 9617, 1868, 14]; differs by 1 level on rounding-boundary pixels.)
export const GRAY_OPENCV5 = [9798, 19235, 3735, 15];
export const GRAY_OPENCV4 = [4899, 9617, 1868, 14];
export function toGray(src, n, stride = 3, [cr, cg, cb, sh] = GRAY_OPENCV5) {
  const g = new Uint8Array(n), half = 1 << (sh - 1);
  for (let i = 0, p = 0; i < n; i++, p += stride) g[i] = (src[p] * cr + src[p + 1] * cg + src[p + 2] * cb + half) >> sh;
  return g;
}

// cv2.Laplacian(gray, cv2.CV_64F) — ksize=1 kernel [0 1 0; 1 -4 1; 0 1 0], BORDER_REFLECT_101 —
// then numpy .var() (population variance). Optionally writes |laplacian| clamped to 0..255 into edgeOut.
export function laplacianVariance(g, w, h, edgeOut = null) {
  const rf = (i, n) => (n === 1 ? 0 : i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  const n = w * h, lap = new Float64Array(n);
  let sum = 0;
  for (let y = 0; y < h; y++) {
    const yu = rf(y - 1, h) * w, yd = rf(y + 1, h) * w, yc = y * w;
    for (let x = 0; x < w; x++) {
      const v = g[yu + x] + g[yd + x] + g[yc + rf(x - 1, w)] + g[yc + rf(x + 1, w)] - 4 * g[yc + x];
      lap[yc + x] = v; sum += v;
    }
  }
  const mean = sum / n;
  let acc = 0;
  for (let i = 0; i < n; i++) { const d = lap[i] - mean; acc += d * d; }
  if (edgeOut) for (let i = 0; i < n; i++) edgeOut[i] = Math.min(255, Math.abs(lap[i]));
  return acc / n;
}
export function brightness(g) { let s = 0; for (let i = 0; i < g.length; i++) s += g[i]; return s / g.length; }
export function decide(blur, bright, t = DEFAULTS) { return blur >= t.blur_min && t.bright_min <= bright && bright <= t.bright_max; }

// Whole pipeline from canvas RGBA at native (already EXIF-oriented) size.
export function analyzeRGBA(rgba, w, h, { thresholds = DEFAULTS, maxDim = RESIZE_MAX_DIM, edges = false, onStage = () => {} } = {}) {
  const t = targetSize(w, h, maxDim);
  let gray;
  if (t.resized) { const rgb = resizeLanczos(rgba, w, h, 4, t.w, t.h); onStage('resize'); gray = toGray(rgb, t.w * t.h, 3); }
  else gray = toGray(rgba, w * h, 4);
  onStage('grayscale');
  const edgeOut = edges ? new Uint8ClampedArray(t.w * t.h) : null;
  const blur_score = laplacianVariance(gray, t.w, t.h, edgeOut);
  onStage('laplacian');
  const b = brightness(gray);
  return {
    response: { blur_score, brightness: b, width: t.w, height: t.h, is_ok: decide(blur_score, b, thresholds),
      thresholds: { blur_min: thresholds.blur_min, bright_min: thresholds.bright_min, bright_max: thresholds.bright_max } },
    source: { width: w, height: h, resized: t.resized }, edges: edgeOut,
  };
}
