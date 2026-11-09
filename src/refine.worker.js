/**
 * refine.worker.js – PHÓNG MẶT NẠ VỀ ĐỘ PHÂN GIẢI GỐC & GHÉP VÀO ẢNH
 * ----------------------------------------------------------------------------
 * Đây là phần quyết định "giữ được độ phân giải". Chạy trong Web Worker để
 * giao diện không bị đứng khi xử lý ảnh hàng chục megapixel.
 *
 * VẤN ĐỀ: AI chỉ cho mặt nạ 1024×1024. Nếu ảnh gốc 6000×4000 mà ta chỉ phóng to
 * mặt nạ (bilinear) thì viền sẽ mờ nhòe, sợi tóc bị mất, mép bị bậc thang.
 *
 * GIẢI PHÁP: FAST GUIDED FILTER (Kaiming He, 2015)
 *   Giả định: trong một vùng nhỏ, alpha là hàm tuyến tính của độ sáng ảnh:
 *           q(x) = a · I(x) + b
 *   - I = độ sáng (grayscale) của ảnh, p = mặt nạ thô của AI.
 *   - Ở mỗi cửa sổ bán kính r, tìm a, b sao cho a·I + b gần p nhất (bình phương
 *     tối thiểu), có hệ số phạt eps để tránh a quá lớn:
 *           a = cov(I, p) / (var(I) + eps)
 *           b = mean(p) − a · mean(I)
 *   - Vùng chủ thể đặc (p≈1) hoặc nền (p≈0): cov = 0 ⇒ a = 0, b = p (giữ nguyên).
 *   - Vùng viền: a ≠ 0 ⇒ alpha "đi theo" biên sáng/tối thật của ảnh.
 *   "Fast": a, b được tính ở độ phân giải thấp (≤1536px) cho nhẹ, sau đó nội suy
 *   a, b lên và áp công thức q = a·I + b với I lấy từ TỪNG ĐIỂM ẢNH GỐC.
 *   ⇒ Viền sắc nét ở độ phân giải đầy đủ, tốn rất ít bộ nhớ.
 *
 * Cuối cùng: chỉ ghi kênh alpha vào ảnh gốc, giữ nguyên R, G, B.
 */

/**
 * Trung bình hộp (box filter) bán kính r, độ phức tạp O(N) không phụ thuộc r.
 * Dùng tổng trượt: ngang trước, dọc sau. Ở mép ảnh chia cho số điểm thực có.
 */
function boxMean(src, w, h, r, out, tmp) {
  // --- Lượt ngang ---
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let sum = 0;
    for (let k = 0; k < Math.min(r, w); k++) sum += src[o + k];
    for (let x = 0; x < w; x++) {
      if (x + r < w) sum += src[o + x + r];
      if (x - r - 1 >= 0) sum -= src[o + x - r - 1];
      tmp[o + x] = sum / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
    }
  }
  // --- Lượt dọc (cộng dồn theo hàng để truy cập bộ nhớ tuần tự, nhanh hơn) ---
  const col = new Float64Array(w);
  for (let y = 0; y < Math.min(r, h); y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) col[x] += tmp[o + x];
  }
  for (let y = 0; y < h; y++) {
    if (y + r < h) { const o = (y + r) * w; for (let x = 0; x < w; x++) col[x] += tmp[o + x]; }
    if (y - r - 1 >= 0) { const o = (y - r - 1) * w; for (let x = 0; x < w; x++) col[x] -= tmp[o + x]; }
    const cnt = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = col[x] / cnt;
  }
}

/** Lấy mẫu song tuyến (bilinear) mặt nạ mw×mh sang lưới w×h, trả về Float32 0..1. */
function resampleMask(mask, mw, mh, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mh - 1, Math.max(0, (y + 0.5) * mh / h - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(mh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mw - 1, Math.max(0, (x + 0.5) * mw / w - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(mw - 1, x0 + 1), fx = sx - x0;
      const top = mask[y0 * mw + x0] * (1 - fx) + mask[y0 * mw + x1] * fx;
      const bot = mask[y1 * mw + x0] * (1 - fx) + mask[y1 * mw + x1] * fx;
      out[y * w + x] = (top * (1 - fy) + bot * fy) / 255;
    }
  }
  return out;
}

/** Tính hệ số (A, B) ở độ phân giải thấp. Nếu tắt refine: A = 0, B = mặt nạ. */
function computeCoefficients(p, guide, gw, gh, refine, radius, eps) {
  const N = gw * gh;
  if (!refine) return { A: new Float32Array(N), B: p };

  // I = độ sáng chuẩn hóa 0..1 theo chuẩn Rec.601
  const I = new Float32Array(N);
  for (let i = 0; i < N; i++) I[i] = (0.299 * guide[i * 4] + 0.587 * guide[i * 4 + 1] + 0.114 * guide[i * 4 + 2]) / 255;

  const tmp = new Float32Array(N), prod = new Float32Array(N);
  const mI = new Float32Array(N), mP = new Float32Array(N);
  const mII = new Float32Array(N), mIP = new Float32Array(N);

  boxMean(I, gw, gh, radius, mI, tmp);                 // mean(I)
  boxMean(p, gw, gh, radius, mP, tmp);                 // mean(p)
  for (let i = 0; i < N; i++) prod[i] = I[i] * I[i];
  boxMean(prod, gw, gh, radius, mII, tmp);             // mean(I²)
  for (let i = 0; i < N; i++) prod[i] = I[i] * p[i];
  boxMean(prod, gw, gh, radius, mIP, tmp);             // mean(I·p)

  // a = cov(I,p) / (var(I) + eps) ; b = mean(p) − a·mean(I)   (ghi đè tại chỗ để tiết kiệm RAM)
  for (let i = 0; i < N; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    const cov = mIP[i] - mI[i] * mP[i];
    const a = cov / (varI + eps);
    mII[i] = a;
    mIP[i] = mP[i] - a * mI[i];
  }
  // Làm mượt a, b thêm một lần (bước chuẩn của Guided Filter) → A, B
  const A = p;  // tái sử dụng bộ nhớ của p (không cần nữa)
  const B = mI;
  boxMean(mII, gw, gh, radius, A, tmp);
  boxMean(mIP, gw, gh, radius, B, tmp);
  return { A, B };
}

self.onmessage = (e) => {
  const { id, mask, maskSize, guide, gw, gh, full, W, H, params } = e.data;
  try {
    const t0 = performance.now();
    const { refine, radius, low, high } = params;

    // 1) Mặt nạ AI (1024×1024, bị kéo giãn) → lưới thấp gw×gh đúng tỉ lệ ảnh
    const p = resampleMask(mask, maskSize, maskSize, gw, gh);

    // 2) Tính A, B. Bán kính quy đổi theo kích thước lưới để ảnh nhỏ/lớn đều hợp lý
    const r = Math.max(1, Math.round(radius * Math.max(gw, gh) / 1536));
    const { A, B } = computeCoefficients(p, guide, gw, gh, refine, r, 1e-3);

    // 3) Áp lên TỪNG điểm ảnh gốc: alpha = A·I_gốc + B, rồi làm sạch theo ngưỡng
    //    Tính trước chỉ số cột nội suy để vòng lặp chính chạy nhanh.
    const x0s = new Int32Array(W), x1s = new Int32Array(W), fxs = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(gw - 1, Math.max(0, (x + 0.5) * gw / W - 0.5));
      x0s[x] = Math.floor(sx); x1s[x] = Math.min(gw - 1, x0s[x] + 1); fxs[x] = sx - x0s[x];
    }
    const lo = low, span = Math.max(1e-3, high - low);

    for (let y = 0; y < H; y++) {
      const sy = Math.min(gh - 1, Math.max(0, (y + 0.5) * gh / H - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(gh - 1, y0 + 1), fy = sy - y0;
      const r0 = y0 * gw, r1 = y1 * gw;
      let i = y * W * 4;
      for (let x = 0; x < W; x++, i += 4) {
        const a0 = x0s[x], a1 = x1s[x], fx = fxs[x];
        const a = (A[r0 + a0] * (1 - fx) + A[r0 + a1] * fx) * (1 - fy) + (A[r1 + a0] * (1 - fx) + A[r1 + a1] * fx) * fy;
        const b = (B[r0 + a0] * (1 - fx) + B[r0 + a1] * fx) * (1 - fy) + (B[r1 + a0] * (1 - fx) + B[r1 + a1] * fx) * fy;
        const lum = (0.299 * full[i] + 0.587 * full[i + 1] + 0.114 * full[i + 2]) / 255;
        let q = a * lum + b;                        // alpha thô ở độ phân giải gốc
        q = (q - lo) / span;                        // làm sạch: < low → 0, > high → 1
        q = q < 0 ? 0 : q > 1 ? 1 : q;
        full[i + 3] = Math.round(q * full[i + 3]);  // nhân với alpha sẵn có (PNG đã trong suốt)
      }
    }
    self.postMessage({ id, full, ms: performance.now() - t0 }, [full.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
