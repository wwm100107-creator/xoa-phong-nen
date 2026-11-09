/**
 * segment.js – CHẠY AI ĐỂ LẤY MẶT NẠ CHỦ THỂ (ALPHA MASK)
 * ----------------------------------------------------------------------------
 * Mô hình: IS-Net (Dichotomous Image Segmentation) do thư viện
 * @imgly/background-removal đóng gói, chạy bằng ONNX Runtime Web:
 *   - WebGPU (card đồ họa)  → nhanh nhất, nếu trình duyệt hỗ trợ.
 *   - WebAssembly (CPU)     → phương án dự phòng, chạy được mọi nơi.
 *
 * Mô hình chỉ nhận ảnh 1024×1024. Vì vậy:
 *   1. Ta TỰ thu nhỏ ảnh gốc về 1024×1024 bằng cách giảm ½ nhiều lần
 *      (chất lượng tốt hơn nhiều so với nội suy song tuyến 1 bước từ ảnh 6000px).
 *   2. AI trả về mặt nạ 1024×1024 (mỗi điểm 0..255).
 *   3. Mặt nạ này KHÔNG được dùng trực tiếp – nó sẽ được "phóng" về độ phân giải
 *      gốc bằng Guided Filter trong refine.worker.js.
 */
import { segmentForeground } from '@imgly/background-removal';

export const AI_SIZE = 1024;

/**
 * Thu nhỏ chất lượng cao: giảm một nửa liên tục cho tới gần kích thước đích,
 * rồi vẽ bước cuối. Mỗi bước dùng imageSmoothingQuality = 'high'.
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

/** Kiểm tra trình duyệt có WebGPU dùng được hay không. */
let gpuOk = null;
async function hasWebGPU() {
  if (gpuOk !== null) return gpuOk;
  try { gpuOk = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); }
  catch { gpuOk = false; }
  return gpuOk;
}

/**
 * Chạy AI trên ảnh gốc (canvas), trả về mặt nạ Uint8Array dài 1024*1024.
 * @param {HTMLCanvasElement} srcCanvas  ảnh gốc
 * @param {string} model  'isnet' | 'isnet_fp16' | 'isnet_quint8'
 * @param {(label:string, ratio:number)=>void} onProgress
 */
export async function predictMask(srcCanvas, model, onProgress) {
  // Bước 1: thu nhỏ về đúng kích thước đầu vào của mô hình (kéo giãn, giống lúc huấn luyện)
  const small = resizeHQ(srcCanvas, AI_SIZE, AI_SIZE);
  const blob = await new Promise((r) => small.toBlob(r, 'image/png'));

  // Bước 2: cấu hình thư viện. progress() báo tiến độ tải mô hình (chỉ lần đầu).
  const progress = (key, cur, total) => {
    if (key.startsWith('fetch')) onProgress?.('Đang tải mô hình AI (chỉ lần đầu)…', total ? cur / total : 0);
    else onProgress?.('AI đang phân tích chủ thể…', 1);
  };
  const base = {
    model,
    progress,
    output: { format: 'image/x-rgba8' }, // nhận dữ liệu thô RGBA, không nén lại PNG
  };

  // Bước 3: ưu tiên GPU, lỗi thì tự quay về CPU
  let out;
  if (await hasWebGPU()) {
    try { out = await segmentForeground(blob, { ...base, device: 'gpu' }); }
    catch (e) { console.warn('WebGPU lỗi, chuyển sang CPU:', e); gpuOk = false; }
  }
  if (!out) out = await segmentForeground(blob, { ...base, device: 'cpu' });

  // Bước 4: dữ liệu trả về là RGBA 1024×1024, mặt nạ nằm ở kênh A (byte thứ 4)
  const rgba = new Uint8Array(await out.arrayBuffer());
  const mask = new Uint8Array(AI_SIZE * AI_SIZE);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3];
  return mask;
}
