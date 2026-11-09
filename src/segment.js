/**
 * segment.js – ĐIỀU PHỐI AI: DỰ ĐOÁN TOÀN ẢNH, RỒI SOI CẬN CHỦ THỂ
 * ----------------------------------------------------------------------------
 * Mô hình chỉ nhìn được 1024×1024. Khi chủ thể chiếm một phần nhỏ của ảnh, chạy lần
 * hai trên khung cắt sát chủ thể để mô hình có nhiều điểm ảnh hơn ở đường viền.
 * Kết quả là các "lớp" mặt nạ, được ghép trong refine.core.js.
 */
import { predictWithModel, MODEL_SIZE } from './rmbg.js';

export function resizeHQ(src, w, h) {
  let cur = src, cw = src.width, ch = src.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const nw = Math.max(w, Math.floor(cw / 2)), nh = Math.max(h, Math.floor(ch / 2));
    cur = step(cur, nw, nh); cw = nw; ch = nh;
  }
  return step(cur, w, h);

  function step(s, nw, nh) {
    const c = document.createElement('canvas');
    c.width = nw; c.height = nh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s, 0, 0, nw, nh);
    return c;
  }
}

/** Khung soi cận tính theo tỉ lệ ảnh (0..1), hoặc null nếu soi cận không có lợi. */
function focusRect(mask, W, H) {
  const S = MODEL_SIZE;
  let minX = S, minY = S, maxX = -1, maxY = -1;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (mask[y * S + x] >= 0.5) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  // Chừa lề để mô hình còn thấy bối cảnh quanh chủ thể
  let cx = (minX + maxX + 1) / 2 / S, cy = (minY + maxY + 1) / 2 / S;
  let w = ((maxX - minX + 1) / S) * 1.16, h = ((maxY - minY + 1) / S) * 1.16;

  // Khung quá dẹt sẽ bị méo mạnh khi co về hình vuông: nới cạnh ngắn ra
  const maxAspect = 1.6;
  if (w * W > h * H * maxAspect) h = (w * W) / (H * maxAspect);
  else if (h * H > w * W * maxAspect) w = (h * H) / (W * maxAspect);

  w = Math.min(1, w); h = Math.min(1, h);
  if (Math.max(w, h) > 0.8) return null;
  if (w * W < 64 || h * H < 64) return null;

  const x = Math.max(0, Math.min(1 - w, cx - w / 2));
  const y = Math.max(0, Math.min(1 - h, cy - h / 2));
  return { x, y, w, h };
}

/**
 * Chạy AI trên ảnh gốc.
 * @returns {Promise<Array<{mask: Float32Array, w: number, h: number, rect?: object}>>}
 */
export async function predictLayers(srcCanvas, onProgress) {
  const W = srcCanvas.width, H = srcCanvas.height;
  const k = Math.min(1, 2048 / Math.max(W, H));
  const input = k < 1 ? resizeHQ(srcCanvas, Math.round(W * k), Math.round(H * k)) : srcCanvas;

  onProgress?.('AI đang phân tích chủ thể...', null);
  const base = await predictWithModel(input, onProgress);
  const layers = [{ mask: base, w: MODEL_SIZE, h: MODEL_SIZE }];

  const rect = focusRect(base, W, H);
  if (rect) {
    onProgress?.('AI đang soi cận đường viền...', null);
    const cw = Math.round(rect.w * W), ch = Math.round(rect.h * H);
    const scale = Math.min(1, 2048 / Math.max(cw, ch));
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(cw * scale));
    crop.height = Math.max(1, Math.round(ch * scale));
    const ctx = crop.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, Math.round(rect.x * W), Math.round(rect.y * H), cw, ch, 0, 0, crop.width, crop.height);
    const focused = await predictWithModel(crop, onProgress);
    layers.push({ mask: focused, w: MODEL_SIZE, h: MODEL_SIZE, rect });
  }
  return layers;
}
