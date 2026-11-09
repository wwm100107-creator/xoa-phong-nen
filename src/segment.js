/**
 * segment.js – CHẠY AI ĐỂ LẤY MẶT NẠ CHỦ THỂ (ALPHA MASK)
 * ----------------------------------------------------------------------------
 * Hỗ trợ 2 kiến trúc mô hình:
 *   1. BRIA RMBG-1.4 (Khuyên dùng): Mô hình SOTA hàng đầu thế giới về tách nền,
 *      giữ trọn vẹn lá cây, sticker, tóc tơ, nhiều vật thể cùng lúc.
 *   2. IS-Net (@imgly): Mô hình phân đoạn đối tượng đơn lẻ.
 */
import { segmentForeground } from '@imgly/background-removal';
import { predictRMBG } from './rmbg.js';

export const AI_SIZE = 1024;

/**
 * Thu nhỏ chất lượng cao: giảm một nửa liên tục cho tới gần kích thước đích.
 */
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
 * Chạy AI trên ảnh gốc (canvas), trả về mặt nạ Uint8Array dài 1024*1024.
 * @param {HTMLCanvasElement} srcCanvas ảnh gốc
 * @param {string} model 'rmbg-1.4' | 'isnet' | 'isnet_fp16' | 'isnet_quint8'
 * @param {(label:string, ratio:number)=>void} onProgress
 */
export async function predictMask(srcCanvas, model, onProgress) {
  // Ưu tiên mô hình BRIA RMBG-1.4
  if (model === 'rmbg-1.4') {
    // Thu nhỏ HQ về kích thước hợp lý (tối đa 1024) trước khi đưa vào RMBG
    const maxSide = Math.max(srcCanvas.width, srcCanvas.height);
    let inputCanvas = srcCanvas;
    if (maxSide > AI_SIZE) {
      const k = AI_SIZE / maxSide;
      inputCanvas = resizeHQ(srcCanvas, Math.round(srcCanvas.width * k), Math.round(srcCanvas.height * k));
    }
    return await predictRMBG(inputCanvas, onProgress);
  }

  // Phương án IS-Net (@imgly)
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
