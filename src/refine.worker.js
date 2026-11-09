/**
 * refine.worker.js – PHÓNG MẶT NẠ VỀ ĐỘ PHÂN GIẢI GỐC & TỐI ƯU HÓA VIỀN
 * ----------------------------------------------------------------------------
 * CẢI TIẾN LỚN:
 * 1. Cơ chế Uncertainty Band: Guided Filter chỉ can thiệp vào dải viền mờ (0.05 < alpha < 0.95).
 *    Vùng chắc chắn là nền (<= 0.05) và vùng chủ thể (>= 0.95) được bảo vệ tuyệt đối,
 *    không bị lem chi tiết nền (như chữ báo, mũi tên, vân giấy cũ) vào chủ thể.
 * 2. Box Filter O(N) tính hệ số trên lưới dẫn đường (Guide).
 * 3. Nội suy song tuyến mượt mà lên độ phân giải gốc đầy đủ.
 */

function boxMean(src, w, h, r, out, tmp) {
  // Lượt ngang
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
  // Lượt dọc
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

function computeCoefficients(p, guide, gw, gh, refine, radius, eps) {
  const N = gw * gh;
  if (!refine) return { A: new Float32Array(N), B: p };

  const I = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    I[i] = (0.299 * guide[i * 4] + 0.587 * guide[i * 4 + 1] + 0.114 * guide[i * 4 + 2]) / 255;
  }

  const tmp = new Float32Array(N), prod = new Float32Array(N);
  const mI = new Float32Array(N), mP = new Float32Array(N);
  const mII = new Float32Array(N), mIP = new Float32Array(N);

  boxMean(I, gw, gh, radius, mI, tmp);
  boxMean(p, gw, gh, radius, mP, tmp);
  for (let i = 0; i < N; i++) prod[i] = I[i] * I[i];
  boxMean(prod, gw, gh, radius, mII, tmp);
  for (let i = 0; i < N; i++) prod[i] = I[i] * p[i];
  boxMean(prod, gw, gh, radius, mIP, tmp);

  for (let i = 0; i < N; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    const cov = mIP[i] - mI[i] * mP[i];
    const a = cov / (varI + eps);
    mII[i] = a;
    mIP[i] = mP[i] - a * mI[i];
  }
  const A = new Float32Array(N);
  const B = new Float32Array(N);
  boxMean(mII, gw, gh, radius, A, tmp);
  boxMean(mIP, gw, gh, radius, B, tmp);
  return { A, B };
}

self.onmessage = (e) => {
  const { id, mask, maskSize, guide, gw, gh, full, W, H, params } = e.data;
  try {
    const t0 = performance.now();
    const { refine, radius, low, high } = params;

    // 1) Lấy mẫu mặt nạ AI về lưới dẫn đường (gw, gh)
    const p = resampleMask(mask, maskSize, maskSize, gw, gh);

    // 2) Tính hệ số A, B
    const r = Math.max(1, Math.round(radius * Math.max(gw, gh) / 1536));
    const { A, B } = computeCoefficients(p, guide, gw, gh, refine, r, 1e-3);

    // 3) Bảng tra tọa độ X
    const x0s = new Int32Array(W), x1s = new Int32Array(W), fxs = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(gw - 1, Math.max(0, (x + 0.5) * gw / W - 0.5));
      x0s[x] = Math.floor(sx); x1s[x] = Math.min(gw - 1, x0s[x] + 1); fxs[x] = sx - x0s[x];
    }

    const lo = low, span = Math.max(1e-3, high - low);

    // 4) Áp dụng lên từng điểm ảnh gốc
    for (let y = 0; y < H; y++) {
      const sy = Math.min(gh - 1, Math.max(0, (y + 0.5) * gh / H - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(gh - 1, y0 + 1), fy = sy - y0;
      const r0 = y0 * gw, r1 = y1 * gw;
      let i = y * W * 4;

      for (let x = 0; x < W; x++, i += 4) {
        const a0 = x0s[x], a1 = x1s[x], fx = fxs[x];
        
        // Giá trị mặt nạ gốc được nội suy
        const pVal = (p[r0 + a0] * (1 - fx) + p[r0 + a1] * fx) * (1 - fy) + 
                     (p[r1 + a0] * (1 - fx) + p[r1 + a1] * fx) * fy;

        let q = pVal;

        if (refine) {
          // Trọng số vùng bất định (Uncertainty weight)
          // Khi pVal ở gần biên (0.5), w tiến về 1.0 -> Guided Filter tối ưu viền
          // Khi pVal <= 0.05 hoặc >= 0.95, w tiến về 0.0 -> Giữ nguyên, không lem nền
          let w = 1.0 - 2.0 * Math.abs(pVal - 0.5);
          if (w < 0) w = 0;

          if (w > 0.01) {
            const a = (A[r0 + a0] * (1 - fx) + A[r0 + a1] * fx) * (1 - fy) + 
                      (A[r1 + a0] * (1 - fx) + A[r1 + a1] * fx) * fy;
            const b = (B[r0 + a0] * (1 - fx) + B[r0 + a1] * fx) * (1 - fy) + 
                      (B[r1 + a0] * (1 - fx) + B[r1 + a1] * fx) * fy;
            const lum = (0.299 * full[i] + 0.587 * full[i + 1] + 0.114 * full[i + 2]) / 255;
            let qGuided = a * lum + b;
            if (qGuided < 0) qGuided = 0;
            else if (qGuided > 1) qGuided = 1;

            q = (1 - w) * pVal + w * qGuided;
          }
        }

        // Làm sạch theo ngưỡng người dùng chọn
        q = (q - lo) / span;
        q = q < 0 ? 0 : q > 1 ? 1 : q;

        // Cập nhật kênh Alpha (giữ nguyên R, G, B gốc)
        full[i + 3] = Math.round(q * full[i + 3]);
      }
    }

    self.postMessage({ id, full, ms: performance.now() - t0 }, [full.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
