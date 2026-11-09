/**
 * segment.js – HỆ THỐNG ĐIỀU PHỐI MÔ HÌNH PHÂN ĐOẠN ẢNH (UYUT AI)
 * ----------------------------------------------------------------------------
 * Hỗ trợ các mô hình hàng đầu thế giới:
 *   1. ⭐ BRIA RMBG-1.4 Studio (~44MB): Nhanh, chuẩn, tiết kiệm RAM.
 *   2. ✨ BiRefNet Lite (~114MB): Giải thưởng ECCV 2024, viền cực chuẩn, chi tiết siêu mịn.
 *   3. IS-Net (@imgly): Mô hình phân đoạn đơn lẻ truyền thống.
 */
import { segmentForeground } from '@imgly/background-removal';
import { predictWithModel } from './rmbg.js';

export const AI_SIZE = 1024;

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

let gpuOk = null;
async function hasWebGPU() {
  if (gpuOk !== null) return gpuOk;
  try { gpuOk = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); }
  catch { gpuOk = false; }
  return gpuOk;
}

/**
 * Chạy AI dự đoán mặt nạ từ ảnh canvas gốc.
 */
export async function predictMask(srcCanvas, model, onProgress) {
  // 1) Các mô hình SOTA (RMBG-1.4 và BiRefNet)
  if (model === 'rmbg-1.4' || model === 'birefnet') {
    const maxSide = Math.max(srcCanvas.width, srcCanvas.height);
    let inputCanvas = srcCanvas;
    if (maxSide > AI_SIZE) {
      const k = AI_SIZE / maxSide;
      inputCanvas = resizeHQ(srcCanvas, Math.round(srcCanvas.width * k), Math.round(srcCanvas.height * k));
    }
    return await predictWithModel(inputCanvas, model, onProgress);
  }

  // 2) Mô hình IS-Net (@imgly)
  const small = resizeHQ(srcCanvas, AI_SIZE, AI_SIZE);
  const blob = await new Promise((r) => small.toBlob(r, 'image/png'));

  const progress = (key, cur, total) => {
    if (key.startsWith('fetch')) onProgress?.('Đang tải mô hình IS-Net (chỉ lần đầu)…', total ? cur / total : 0);
    else onProgress?.('AI đang phân tích chủ thể…', 1);
  };
  const base = {
    model,
    progress,
    output: { format: 'image/x-rgba8' },
  };

  let out;
  if (await hasWebGPU()) {
    try { out = await segmentForeground(blob, { ...base, device: 'gpu' }); }
    catch (e) { console.warn('WebGPU lỗi, chuyển sang CPU:', e); gpuOk = false; }
  }
  if (!out) out = await segmentForeground(blob, { ...base, device: 'cpu' });

  const rgba = new Uint8Array(await out.arrayBuffer());
  const mask = new Uint8Array(AI_SIZE * AI_SIZE);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3];
  return mask;
}
