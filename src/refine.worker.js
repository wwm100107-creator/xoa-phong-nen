/**
 * refine.worker.js – ENGINE TINH CHỈNH VIỀN & NÂNG CẤP ĐỘ PHÂN GIẢI GỐC (UYUT 3.0)
 * ----------------------------------------------------------------------------
 * Đột phá logic:
 * 1. BẢO VỆ CHỦ THỂ TUYỆT ĐỐI (Solid Foreground Protection):
 *    - Các chi tiết tối màu (lá cây xanh đậm, tóc, đồng tử, vân bề mặt) có xác suất AI >= 0.70
 *      được bảo vệ 100% độ đặc, KHÔNG bao giờ bị Guided Filter đơn sắc biến thành trong suốt/rỗng ruột!
 * 2. LỌC BÓNG ĐỔ THÔNG MINH (Smart Deshadowing):
 *    - Tự động nhận diện bóng đen/xám đổ dưới chân vật thể trên mặt bàn/giấy và triệt tiêu sạch sẽ.
 * 3. THU GỌN VIỀN / XÓA VIỀN THỪA (Edge Trim / Shrink):
 *    - Co viền mặt nạ từ 0 - 5px giúp bóc sạch viền giấy trắng của sticker, viền lem màu nền cũ.
 * 4. KHỬ LEM MÀU VIỀN (Color Decontamination / Defringe):
 *    - Làm sạch các pixel viền mờ, chống viền đen bẩn khi đặt lên nền trắng hoặc trong suốt.
 */

function boxMean(src, w, h, r, out, tmp) {
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

function trimAlpha(alpha, w, h, radius) {
  if (radius <= 0) return alpha;
  const out = new Float32Array(w * h);
  const r2 = radius * radius;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let minVal = alpha[y * w + x];
      if (minVal > 0) {
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          const dy2 = dy * dy;
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy2 > r2) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const v = alpha[ny * w + nx];
            if (v < minVal) {
              minVal = v;
              if (minVal === 0) break;
            }
          }
          if (minVal === 0) break;
        }
      }
      out[y * w + x] = minVal;
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
    const { refine, radius, low, high, trim = 0, deshadow = true } = params;

    // 1) Lấy mẫu mặt nạ AI lên lưới dẫn đường
    let p = resampleMask(mask, maskSize, maskSize, gw, gh);

    // 2) Tùy chọn Thu gọn viền (Edge Trim) giúp bóc sạch viền thừa
    if (trim > 0) {
      const trimPixels = Math.max(1, Math.round(trim * Math.max(gw, gh) / 1000));
      p = trimAlpha(p, gw, gh, trimPixels);
    }

    // 3) Tính hệ số Guided Filter
    const r = Math.max(1, Math.round(radius * Math.max(gw, gh) / 1536));
    const { A, B } = computeCoefficients(p, guide, gw, gh, refine, r, 1e-3);

    // 4) Bảng tra cứu tọa độ X
    const x0s = new Int32Array(W), x1s = new Int32Array(W), fxs = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(gw - 1, Math.max(0, (x + 0.5) * gw / W - 0.5));
      x0s[x] = Math.floor(sx); x1s[x] = Math.min(gw - 1, x0s[x] + 1); fxs[x] = sx - x0s[x];
    }

    const lo = low, span = Math.max(1e-3, high - low);

    // 5) Áp dụng lên từng điểm ảnh gốc với cơ chế Solid Protection & Deshadow
    for (let y = 0; y < H; y++) {
      const sy = Math.min(gh - 1, Math.max(0, (y + 0.5) * gh / H - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(gh - 1, y0 + 1), fy = sy - y0;
      const r0 = y0 * gw, r1 = y1 * gw;
      let i = y * W * 4;

      for (let x = 0; x < W; x++, i += 4) {
        const a0 = x0s[x], a1 = x1s[x], fx = fxs[x];
        const pVal = (p[r0 + a0] * (1 - fx) + p[r0 + a1] * fx) * (1 - fy) + 
                     (p[r1 + a0] * (1 - fx) + p[r1 + a1] * fx) * fy;

        let q = pVal;

        // BẢO VỆ CHỦ THỂ (Solid Protection):
        // Nếu AI xác nhận đối tượng chắc chắn là chủ thể (pVal >= 0.70):
        // Giữ 1.0 trọn vẹn, không để Guided Filter grayscale làm thủng lá hoặc hốc tối!
        if (pVal >= 0.70) {
          q = 1.0;
        } else if (pVal <= 0.12) {
          // Vùng chắc chắn là nền: cắt bỏ sạch
          q = 0.0;
        } else {
          // Vùng chuyển tiếp (0.12 < pVal < 0.70): Áp dụng Guided Filter để khử răng cưa
          if (refine) {
            const a = (A[r0 + a0] * (1 - fx) + A[r0 + a1] * fx) * (1 - fy) + 
                      (A[r1 + a0] * (1 - fx) + A[r1 + a1] * fx) * fy;
            const b = (B[r0 + a0] * (1 - fx) + B[r0 + a1] * fx) * (1 - fy) + 
                      (B[r1 + a0] * (1 - fx) + B[r1 + a1] * fx) * fy;
            const lum = (0.299 * full[i] + 0.587 * full[i + 1] + 0.114 * full[i + 2]) / 255;
            let qGuided = a * lum + b;
            qGuided = qGuided < 0 ? 0 : qGuided > 1 ? 1 : qGuided;

            // Pha trộn mượt mà
            const w = Math.sin((pVal - 0.12) / (0.70 - 0.12) * Math.PI);
            q = (1 - w * 0.7) * pVal + (w * 0.7) * qGuided;
          }

          // Chuẩn hóa theo ngưỡng độ nhạy
          q = (q - lo) / span;
          q = q < 0 ? 0 : q > 1 ? 1 : q;
        }

        // LỌC BÓNG ĐỔ (Smart Deshadowing):
        // Nếu bật và điểm ảnh nằm ở nửa dưới ảnh, có độ sáng thấp, độ bão hòa màu thấp:
        if (deshadow && q > 0 && y > H * 0.70) {
          const rPix = full[i], gPix = full[i + 1], bPix = full[i + 2];
          const maxRGB = Math.max(rPix, gPix, bPix), minRGB = Math.min(rPix, gPix, bPix);
          const sat = maxRGB === 0 ? 0 : (maxRGB - minRGB) / maxRGB;
          const lum = (0.299 * rPix + 0.587 * gPix + 0.114 * bPix) / 255;

          // Bóng đổ thường tối và xám/nâu bẩn
          if (lum < 0.38 && sat < 0.40 && rPix < 110) {
            const shadowWeight = Math.max(0, 1 - (y - H * 0.70) / (H * 0.30));
            q *= shadowWeight * 0.2; // Triệt tiêu bóng đổ dưới đáy
          }
        }

        full[i + 3] = Math.round(q * full[i + 3]);
      }
    }

    self.postMessage({ id, full, ms: performance.now() - t0 }, [full.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
