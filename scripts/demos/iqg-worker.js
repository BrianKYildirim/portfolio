// Module worker for the Image Quality Gate demo: decodes the file (so large photos never block the
// page), reads the pixels and runs the ported analysis, reporting each stage with its measured duration.
import { analyzeRGBA } from './iqg-core.js';

const MAX_PIXELS = 32e6; // browser-only guard, mirrored in iqg.js

// Browsers apply EXIF orientation while decoding, like Pillow's exif_transpose; colour profiles are
// left alone (Pillow ignores them too). Options unsupported by older engines throw a TypeError.
async function decode(blob) {
  try { return await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
  catch (e) { if (e instanceof TypeError) return createImageBitmap(blob); throw e; }
}

self.postMessage({ ready: true }); // lets the page detect a worker that never loaded

self.onmessage = async ({ data }) => {
  const { id, blob, thresholds } = data;
  let { bitmap, rgba, width, height } = data;
  let t = performance.now();
  const stage = (name) => { const now = performance.now(); self.postMessage({ id, stage: name, ms: now - t }); t = now; };
  try {
    if (blob) {
      try { bitmap = await decode(blob); } catch { return self.postMessage({ id, fail: 'decode' }); }
      stage('decode');
      if (bitmap.width * bitmap.height > MAX_PIXELS) { self.postMessage({ id, fail: 'pixels', width: bitmap.width, height: bitmap.height }); return bitmap.close(); }
    }
    if (bitmap) {
      width = bitmap.width; height = bitmap.height;
      const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      rgba = ctx.getImageData(0, 0, width, height).data;
      stage('pixels');
    } else {
      rgba = new Uint8ClampedArray(rgba);
    }
    const r = analyzeRGBA(rgba, width, height, { thresholds, edges: true, onStage: stage });
    stage('decide');
    self.postMessage({ id, done: true, response: r.response, source: r.source, edges: r.edges }, [r.edges.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
