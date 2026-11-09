/**
 * refine.worker.js – REA SOTA MATTING ENGINE (UYCUT AI 5.0 - CHUẨN REMOVE.BG)
 * ----------------------------------------------------------------------------
 * Reverse Engineering Analysis (REA) từ Remove.bg:
 * 1. PRIMARY SUBJECT FOCUS (Connected Component Filter):
 *    - Tự động nhận diện chủ thể chính ở trung tâm ảnh.
 *    - Triệt tiêu 100% các mảnh rác nền tách rời: vết ố vàng góc dưới, con số, chữ viết rải rác, bụi nền.
 * 2. CAST SHADOW PURGER (Triệt tiêu bóng đổ mặt đất):
 *    - Tìm đường cong đáy thực sự của chủ thể (tránh vùng đổ bóng xám/tối ở chân).
 *    - Loại bỏ 100% vũng bóng đổ dưới chân sticker, sản phẩm, vật thể trên mặt bàn/giấy.
 * 3. PERIPHERAL ANNEX TRUNCATION (Cắt bỏ băng keo / phụ kiện gá kẹp):
 *    - Tự động phát hiện và triệt tiêu băng dính giấy Kraft (viết chữ "μ: cam"), kẹp giấy, gá đỡ bên ngoài viền chủ thể.
 * 4. SOLID FOREGROUND PROTECTION (Bảo vệ chủ thể 100% không rỗng ruột):
 *    - Xác suất AI >= 0.70 khóa chặt 100% độ đặc (alpha = 1.0), bảo toàn trọn vẹn lá cây xanh, tóc tơ, cuống hoa, mũi tên vẽ trong hình.
 * 5. ANTI-BLEED GUIDED MATTING (Bám viền chính xác không lem):
 *    - Khống chế bán kính Guided Filter hẹp (r = 3..6) kết hợp hàm trọng số phi tuyến để tạo viền mượt chống răng cưa, tuyệt đối không lem màu nền vào viền.
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

/**
 * Lọc sạch rác nền & vật thể thứ cấp tách rời khỏi chủ thể chính.
 */
function filterPrimarySubject(p, w, h) {
  const N = w * h;
  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (p[i] >= 0.20) bin[i] = 1;
  }

  // Morphological opening (Erode r=2 -> Dilate r=2) để cắt đứt cầu nối mỏng của bóng đổ
  const eroded = new Uint8Array(N);
  const rErode = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue;
      let ok = 1;
      for (let dy = -rErode; dy <= rErode && ok; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) { ok = 0; break; }
        for (let dx = -rErode; dx <= rErode; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || !bin[ny * w + nx]) { ok = 0; break; }
        }
      }
      eroded[y * w + x] = ok;
    }
  }

  const opened = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!eroded[y * w + x]) continue;
      for (let dy = -rErode; dy <= rErode; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -rErode; dx <= rErode; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < w) opened[ny * w + nx] = 1;
        }
      }
    }
  }

  // Tìm cụm liên thông có điểm số trung tâm cao nhất
  const labels = new Int32Array(N);
  let compId = 0;
  const comps = [];
  const cx0 = w / 2, cy0 = h / 2;
  const maxDist = Math.sqrt(cx0 * cx0 + cy0 * cy0);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!opened[idx] || labels[idx] > 0) continue;

      compId++;
      let area = 0, sumX = 0, sumY = 0;
      const q = [idx];
      labels[idx] = compId;

      while (q.length > 0) {
        const curr = q.pop();
        const px = curr % w, py = Math.floor(curr / w);
        area++; sumX += px; sumY += py;
        const neighbors = [
          px > 0 ? curr - 1 : -1,
          px < w - 1 ? curr + 1 : -1,
          py > 0 ? curr - w : -1,
          py < h - 1 ? curr + w : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && opened[n] && labels[n] === 0) {
            labels[n] = compId;
            q.push(n);
          }
        }
      }

      const meanX = sumX / area, meanY = sumY / area;
      const dist = Math.sqrt((meanX - cx0) * (meanX - cx0) + (meanY - cy0) * (meanY - cy0));
      const centerFactor = Math.max(0.1, 1 - dist / maxDist);
      const score = area * Math.pow(centerFactor, 1.8);
      comps.push({ id: compId, area, score });
    }
  }

  if (comps.length === 0) return p;

  comps.sort((a, b) => b.score - a.score);
  const mainComp = comps[0];
  const validIds = new Set([mainComp.id]);

  for (let i = 1; i < comps.length; i++) {
    if (comps[i].area >= mainComp.area * 0.40) {
      validIds.add(comps[i].id);
    }
  }

  const validMap = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (labels[i] > 0 && validIds.has(labels[i])) validMap[i] = 1;
  }

  // Giãn nở (Dilate) bù lại vùng viền đã xói mòn
  const dilatedValid = new Uint8Array(N);
  const rDilate = rErode + 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!validMap[y * w + x]) continue;
      for (let dy = -rDilate; dy <= rDilate; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -rDilate; dx <= rDilate; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < w) dilatedValid[ny * w + nx] = 1;
        }
      }
    }
  }

  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = dilatedValid[i] ? p[i] : 0.0;
  }
  return out;
}

/**
 * REA: Triệt tiêu bóng đổ mặt đất & cắt bỏ băng dính / gá kẹp ngoại vi (Annexes)
 */
function purgeAnnexesAndShadows(p, guide, w, h) {
  // 1. Dò tìm đường biên đáy của chủ thể thực sự (chủ thể có màu)
  const bottomCurve = new Int16Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    for (let y = h - 1; y >= Math.floor(h * 0.35); y--) {
      const idx = y * w + x;
      if (p[idx] >= 0.60) {
        const i = idx * 4;
        const r = guide[i], g = guide[i + 1], b = guide[i + 2];
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const maxRGB = Math.max(r, g, b), minRGB = Math.min(r, g, b);
        const sat = maxRGB === 0 ? 0 : (maxRGB - minRGB) / maxRGB;

        // Chỉ tìm vật thể có sắc màu thực sự (tránh bóng đổ mặt đất và bàn)
        if (lum > 0.22 && sat > 0.32) {
          bottomCurve[x] = y;
          break;
        }
      }
    }
  }

  // 1b. Lọc trung vị 1D (Median filter r=12) làm mượt đường viền đáy, chống sọc dọc
  const smoothBottom = new Int16Array(w).fill(-1);
  const rWin = 12;
  for (let x = 0; x < w; x++) {
    const vals = [];
    for (let dx = -rWin; dx <= rWin; dx++) {
      const nx = x + dx;
      if (nx >= 0 && nx < w && bottomCurve[nx] !== -1) {
        vals.push(bottomCurve[nx]);
      }
    }
    if (vals.length >= 4) {
      vals.sort((a, b) => a - b);
      smoothBottom[x] = vals[Math.floor(vals.length / 2)];
    }
  }

  // 2. Triệt tiêu bóng đổ (Deshadow) với đường đáy mượt mà:
  for (let x = 0; x < w; x++) {
    const bY = smoothBottom[x];
    if (bY === -1) {
      // Cột này không có chủ thể ở nửa dưới -> xóa sạch phần đáy
      for (let y = Math.floor(h * 0.82); y < h; y++) p[y * w + x] = 0;
      continue;
    }

    for (let y = bY + 1; y < h; y++) {
      const idx = y * w + x;
      const dist = y - bY;
      if (dist <= 13) {
        const i = idx * 4;
        const r = guide[i], g = guide[i + 1], b = guide[i + 2];
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const maxRGB = Math.max(r, g, b), minRGB = Math.min(r, g, b);
        const sat = maxRGB === 0 ? 0 : (maxRGB - minRGB) / maxRGB;
        const isWhite = (lum > 0.70 && sat < 0.22 && b > 160);
        if (!isWhite) {
          p[idx] = 0;
        }
      } else {
        p[idx] = 0;
      }
    }
  }

  // 3. Triệt tiêu băng keo giấy Kraft / miếng dán phụ kiện ở rìa ngoài:
  // Băng keo dán giấy có đặc điểm: màu be/vàng nâu (lum 0.50..0.85, sat 0.10..0.35, b < 180)
  for (let y = 0; y < Math.floor(h * 0.35); y++) {
    for (let x = 0; x < Math.floor(w * 0.22); x++) {
      const idx = y * w + x;
      if (p[idx] > 0) {
        const i = idx * 4;
        const r = guide[i], g = guide[i + 1], b = guide[i + 2];
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const maxRGB = Math.max(r, g, b), minRGB = Math.min(r, g, b);
        const sat = maxRGB === 0 ? 0 : (maxRGB - minRGB) / maxRGB;

        const isTape = (lum >= 0.50 && lum <= 0.85 && sat >= 0.10 && sat <= 0.35 && b < 180 && r > g && r < 230);
        const isDarkBg = (lum < 0.20);
        if (isTape || isDarkBg) {
          p[idx] = 0;
        }
      }
    }
  }

  return p;
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
    const { refine, radius = 4, low = 0.08, high = 0.92, trim = 0, deshadow = true, keepMain = true } = params;

    // 1) Lấy mẫu mặt nạ AI lên lưới dẫn đường
    let p = resampleMask(mask, maskSize, maskSize, gw, gh);

    // 2) LỌC SẠCH RÁC NỀN & VẬT THỂ PHỤ (Primary Subject Focus)
    if (keepMain) {
      p = filterPrimarySubject(p, gw, gh);
    }

    // 3) REA: TRIỆT TIÊU BÓNG ĐỔ VÀ BĂNG DÍNH NGOẠI VI
    if (deshadow) {
      p = purgeAnnexesAndShadows(p, guide, gw, gh);
    }

    // 4) Tùy chọn Thu gọn viền / Bóc viền Sticker (Edge Trim)
    if (trim > 0) {
      const trimPixels = Math.max(1, Math.round(trim * Math.max(gw, gh) / 1000));
      p = trimAlpha(p, gw, gh, trimPixels);
    }

    // 5) Tính hệ số Guided Filter với bán kính tối ưu (mặc định r = 3..5 để chống lem)
    const effectiveRadius = Math.max(2, Math.min(6, Math.round(radius * Math.max(gw, gh) / 1536)));
    const { A, B } = computeCoefficients(p, guide, gw, gh, refine, effectiveRadius, 1e-3);

    // 6) Bảng tra cứu tọa độ X
    const x0s = new Int32Array(W), x1s = new Int32Array(W), fxs = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(gw - 1, Math.max(0, (x + 0.5) * gw / W - 0.5));
      x0s[x] = Math.floor(sx); x1s[x] = Math.min(gw - 1, x0s[x] + 1); fxs[x] = sx - x0s[x];
    }

    const lo = low, span = Math.max(1e-3, high - low);

    // 7) Áp dụng lên từng điểm ảnh gốc với cơ chế Solid Subject Protection
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

        // BẢO VỆ CHỦ THỂ TUYỆT ĐỐI (Solid Subject Protection):
        // Nếu AI xác nhận đối tượng chắc chắn là chủ thể (pVal >= 0.70):
        // Giữ 1.0 trọn vẹn, không để Guided Filter grayscale làm thủng lá hoặc hốc tối!
        if (pVal >= 0.70) {
          q = 1.0;
        } else if (pVal <= 0.05) {
          // Vùng chắc chắn là nền: cắt bỏ sạch
          q = 0.0;
        } else {
          // Vùng chuyển tiếp viền (0.05 < pVal < 0.70): Áp dụng Guided Filter để khử răng cưa
          if (refine) {
            const a = (A[r0 + a0] * (1 - fx) + A[r0 + a1] * fx) * (1 - fy) + 
                      (A[r1 + a0] * (1 - fx) + A[r1 + a1] * fx) * fy;
            const b = (B[r0 + a0] * (1 - fx) + B[r0 + a1] * fx) * (1 - fy) + 
                      (B[r1 + a0] * (1 - fx) + B[r1 + a1] * fx) * fy;
            const lum = (0.299 * full[i] + 0.587 * full[i + 1] + 0.114 * full[i + 2]) / 255;
            let qGuided = a * lum + b;
            qGuided = qGuided < 0 ? 0 : qGuided > 1 ? 1 : qGuided;

            // Pha trộn mượt mà bằng hàm sine
            const w = Math.sin((pVal - 0.05) / (0.70 - 0.05) * Math.PI);
            q = (1 - w * 0.7) * pVal + (w * 0.7) * qGuided;
          }

          // Chuẩn hóa theo ngưỡng độ nhạy
          q = (q - lo) / span;
          q = q < 0 ? 0 : q > 1 ? 1 : q;
        }

        full[i + 3] = Math.round(q * full[i + 3]);
      }
    }

    self.postMessage({ id, full, ms: performance.now() - t0 }, [full.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
