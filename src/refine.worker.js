/**
 * refine.worker.js – Chạy bước tinh chỉnh viền (refine.core.js) ngoài luồng giao diện.
 */
import { refine } from './refine.core.js';

self.onmessage = (e) => {
  const { id, layers, guide, gw, gh, full, W, H } = e.data;
  try {
    const t0 = performance.now();
    refine({ layers, guide, gw, gh, full, W, H });
    self.postMessage({ id, full, ms: performance.now() - t0 }, [full.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
