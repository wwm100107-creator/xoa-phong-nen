/**
 * refine.core.js – BIẾN MẶT NẠ AI THÀNH ALPHA CHẤT LƯỢNG CAO Ở ĐỘ PHÂN GIẢI GỐC
 * ----------------------------------------------------------------------------
 * Nguyên tắc: AI quyết định "cái gì là chủ thể", ở đây chỉ làm đẹp đường viền.
 * Không có luật nào dựa trên màu sắc hay vị trí cố định của một loại ảnh cụ thể,
 * vì các luật như vậy luôn phá hỏng những ảnh còn lại.
 *
 * Các bước (mọi phép tính nặng chạy trên "lưới dẫn" gw×gh, ảnh gốc chỉ nội suy):
 *   1. composeLayers      Ghép mặt nạ toàn ảnh với mặt nạ soi cận chủ thể.
 *   2. removeStrayIslands Bỏ đốm rác xa chủ thể, giữ vật thể thật và chi tiết gần.
 *   3. softenCastShadow   Giảm bóng đổ ở vùng AI còn phân vân.
 *   4. guided filter màu  Bám alpha theo biên màu thật của ảnh trong dải viền.
 *   5. estimateForeground Khử màu nền bám ở viền bán trong suốt (Germer et al. 2020).
 *   6. Áp lên ảnh gốc W×H, giữ chi tiết tần số cao của ảnh thật.
 */

const SURE_LOW = 0.03;
const SURE_HIGH = 0.97;

const clip01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const curve = (v) => clip01((v - SURE_LOW) / (SURE_HIGH - SURE_LOW));

/** Trung bình hộp bán kính r, O(N), tự co cửa sổ ở sát biên ảnh. */
export function boxMean(src, w, h, r, out, tmp) {
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

/** Lấy mẫu song tuyến một mặt nạ mw×mh về lưới w×h. */
export function resampleMask(mask, mw, mh, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mh - 1, Math.max(0, (y + 0.5) * mh / h - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(mh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mw - 1, Math.max(0, (x + 0.5) * mw / w - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(mw - 1, x0 + 1), fx = sx - x0;
      const top = mask[y0 * mw + x0] * (1 - fx) + mask[y0 * mw + x1] * fx;
      const bot = mask[y1 * mw + x0] * (1 - fx) + mask[y1 * mw + x1] * fx;
      out[y * w + x] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

/**
 * Ghép các lớp mặt nạ: lớp 0 phủ toàn ảnh, lớp sau là ảnh cắt sát chủ thể (nét hơn).
 * Lớp cắt thấy ít bối cảnh hơn nên chỉ được sửa vùng quanh viền của lớp 0:
 * không được thêm vật thể ở xa, cũng không được đục lỗ giữa chủ thể.
 */
export function composeLayers(layers, gw, gh) {
  const p = resampleMask(layers[0].mask, layers[0].w, layers[0].h, gw, gh);
  if (layers.length < 2) return p;

  const N = gw * gh;
  const solid = new Float32Array(N);
  for (let i = 0; i < N; i++) solid[i] = p[i] >= 0.5 ? 1 : 0;
  const near = new Float32Array(N);
  const tmp = new Float32Array(N);
  boxMean(solid, gw, gh, Math.max(4, Math.round(Math.max(gw, gh) * 0.015)), near, tmp);

  for (let l = 1; l < layers.length; l++) {
    const { mask, w: mw, h: mh, rect } = layers[l];
    const x0 = Math.round(rect.x * gw), y0 = Math.round(rect.y * gh);
    const x1 = Math.min(gw, Math.round((rect.x + rect.w) * gw));
    const y1 = Math.min(gh, Math.round((rect.y + rect.h) * gh));
    const fade = Math.max(4, Math.round(Math.max(x1 - x0, y1 - y0) * 0.03));
    const rw = x1 - x0, rh = y1 - y0;

    for (let y = y0; y < y1; y++) {
      const sy = Math.min(mh - 1, Math.max(0, (y - y0 + 0.5) * mh / rh - 0.5));
      const my0 = Math.floor(sy), my1 = Math.min(mh - 1, my0 + 1), fy = sy - my0;
      for (let x = x0; x < x1; x++) {
        const idx = y * gw + x;
        if (near[idx] <= 0) continue; // quá xa chủ thể: giữ nguyên lớp 0
        const sx = Math.min(mw - 1, Math.max(0, (x - x0 + 0.5) * mw / rw - 0.5));
        const mx0 = Math.floor(sx), mx1 = Math.min(mw - 1, mx0 + 1), fx = sx - mx0;
        const top = mask[my0 * mw + mx0] * (1 - fx) + mask[my0 * mw + mx1] * fx;
        const bot = mask[my1 * mw + mx0] * (1 - fx) + mask[my1 * mw + mx1] * fx;
        let v = top * (1 - fy) + bot * fy;
        if (near[idx] >= 0.999) v = Math.max(v, p[idx]); // lõi chủ thể: không đục lỗ

        // Mờ dần về mép khung cắt (trừ cạnh trùng biên ảnh)
        let k = 1;
        if (x0 > 0) k = Math.min(k, (x - x0) / fade);
        if (y0 > 0) k = Math.min(k, (y - y0) / fade);
        if (x1 < gw) k = Math.min(k, (x1 - 1 - x) / fade);
        if (y1 < gh) k = Math.min(k, (y1 - 1 - y) / fade);
        p[idx] = p[idx] * (1 - k) + v * k;
      }
    }
  }
  return p;
}

/**
 * Bỏ các đốm rác tách rời. Một cụm được giữ nếu nó là cụm lớn nhất, đủ lớn so với
 * cụm lớn nhất (nhiều chủ thể), hoặc nằm gần một cụm đã giữ (sợi tóc rời, khuyên tai,
 * các chữ cái của logo).
 */
export function removeStrayIslands(p, w, h) {
  const N = w * h;
  const labels = new Int32Array(N); // 0 = chưa gán
  const stack = new Int32Array(N);
  const core = [0]; // số điểm chắc chắn (p >= 0.5) của từng cụm, chỉ số từ 1
  let count = 0;

  for (let seed = 0; seed < N; seed++) {
    if (p[seed] < SURE_LOW || labels[seed]) continue;
    count++;
    let c = 0, sp = 0;
    stack[sp++] = seed;
    labels[seed] = count;
    while (sp > 0) {
      const cur = stack[--sp];
      if (p[cur] >= 0.5) c++;
      const cx = cur % w;
      for (let ny = -1; ny <= 1; ny++) {
        const row = cur + ny * w;
        if (row < 0 || row >= N) continue;
        for (let nx = -1; nx <= 1; nx++) {
          const tx = cx + nx;
          if (tx < 0 || tx >= w) continue;
          const n = row + nx;
          if (p[n] >= SURE_LOW && !labels[n]) { labels[n] = count; stack[sp++] = n; }
        }
      }
    }
    core.push(c);
  }
  if (count < 2) return p;

  let mainCore = 0;
  for (let i = 1; i <= count; i++) if (core[i] > mainCore) mainCore = core[i];
  if (mainCore === 0) return p;

  const kept = new Uint8Array(count + 1);
  for (let i = 1; i <= count; i++) if (core[i] >= mainCore * 0.03) kept[i] = 1;

  // Lan dần: cụm nằm gần cụm đã giữ cũng được giữ
  const R = Math.max(3, Math.round(Math.max(w, h) * 0.03));
  const ind = new Float32Array(N), near = new Float32Array(N), tmp = new Float32Array(N);
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < N; i++) ind[i] = labels[i] && kept[labels[i]] ? 1 : 0;
    boxMean(ind, w, h, R, near, tmp);
    let changed = false;
    for (let i = 0; i < N; i++) {
      const l = labels[i];
      if (l && !kept[l] && near[i] > 0) { kept[l] = 1; changed = true; }
    }
    if (!changed) break;
  }

  for (let i = 0; i < N; i++) if (labels[i] && !kept[labels[i]]) p[i] = 0;
  return fadeFarHaze(p, w, h);
}

/**
 * Xóa lớp mờ AI để lại xa chủ thể. Điểm yếu (p < 0.5) chỉ có nghĩa khi nằm gần phần
 * chắc chắn, như tóc hay lông; càng xa thì càng mờ dần về 0.
 */
function fadeFarHaze(p, w, h) {
  const N = w * h;
  const dist = new Float32Array(N);
  const INF = w + h;
  for (let i = 0; i < N; i++) dist[i] = p[i] >= 0.5 ? 0 : INF;

  // Biến đổi khoảng cách chamfer 2 lượt
  const D = 1.4142;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = dist[i];
      if (x > 0 && dist[i - 1] + 1 < d) d = dist[i - 1] + 1;
      if (y > 0) {
        if (dist[i - w] + 1 < d) d = dist[i - w] + 1;
        if (x > 0 && dist[i - w - 1] + D < d) d = dist[i - w - 1] + D;
        if (x < w - 1 && dist[i - w + 1] + D < d) d = dist[i - w + 1] + D;
      }
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = dist[i];
      if (x < w - 1 && dist[i + 1] + 1 < d) d = dist[i + 1] + 1;
      if (y < h - 1) {
        if (dist[i + w] + 1 < d) d = dist[i + w] + 1;
        if (x < w - 1 && dist[i + w + 1] + D < d) d = dist[i + w + 1] + D;
        if (x > 0 && dist[i + w - 1] + D < d) d = dist[i + w - 1] + D;
      }
      dist[i] = d;
    }
  }

  const side = Math.max(w, h);
  const near = side * 0.02, far = side * 0.05;
  for (let i = 0; i < N; i++) {
    if (p[i] < 0.5 && dist[i] > near) p[i] *= clip01((far - dist[i]) / (far - near));
  }
  return p;
}

/** Tách kênh màu của lưới dẫn RGBA thành 3 mảng số thực 0..1. */
function splitChannels(rgba, N) {
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    R[i] = rgba[i * 4] / 255;
    G[i] = rgba[i * 4 + 1] / 255;
    B[i] = rgba[i * 4 + 2] / 255;
  }
  return { R, G, B };
}

/**
 * Giảm bóng đổ: điểm mà AI còn phân vân, có cùng sắc độ với nền xung quanh nhưng
 * tối hơn nền thì nhiều khả năng là bóng. Điểm AI đã chắc chắn thì không đụng tới,
 * nên vật thể xám/đen/trắng không bị ảnh hưởng.
 */
export function softenCastShadow(p, R, G, B, w, h) {
  const N = w * h;
  const r = Math.max(8, Math.round(Math.max(w, h) * 0.04));
  const isBg = new Float32Array(N), tmp = new Float32Array(N);
  const weight = new Float32Array(N), sum = new Float32Array(N);
  const bgR = new Float32Array(N), bgG = new Float32Array(N), bgB = new Float32Array(N);
  let uncertain = 0;
  for (let i = 0; i < N; i++) {
    isBg[i] = p[i] <= 0.02 ? 1 : 0;
    if (p[i] > SURE_LOW && p[i] < 0.85) uncertain++;
  }
  if (!uncertain) return p;

  boxMean(isBg, w, h, r, weight, tmp);
  const channels = [[R, bgR], [G, bgG], [B, bgB]];
  for (const [src, dst] of channels) {
    for (let i = 0; i < N; i++) sum[i] = src[i] * isBg[i];
    boxMean(sum, w, h, r, dst, tmp);
  }

  for (let i = 0; i < N; i++) {
    const a = p[i];
    if (a <= SURE_LOW || a >= 0.85 || weight[i] < 0.05) continue;
    const wgt = weight[i];
    const br = bgR[i] / wgt, bg = bgG[i] / wgt, bb = bgB[i] / wgt;
    const bSum = br + bg + bb, iSum = R[i] + G[i] + B[i];
    if (bSum < 0.15 || iSum < 1e-3) continue;

    const ratio = iSum / bSum;
    if (ratio >= 0.98 || ratio < 0.2) continue; // không tối hơn nền, hoặc quá tối để là bóng

    // Bóng làm tối nền nhưng gần như giữ nguyên tỉ lệ màu
    const dr = R[i] / iSum - br / bSum;
    const dg = G[i] / iSum - bg / bSum;
    const db = B[i] / iSum - bb / bSum;
    const chroma = Math.sqrt(dr * dr + dg * dg + db * db);
    const match = clip01(1 - chroma / 0.05);
    if (match <= 0) continue;

    // AI càng chắc thì càng giảm ít, về 0 tại p = 0.85
    const doubt = clip01((0.85 - a) / 0.45);
    p[i] = a * (1 - match * doubt);
  }
  return p;
}

/** Guided filter đa kênh màu (He et al.), trả về hệ số tuyến tính cho từng điểm. */
function colorGuidedFilter(p, R, G, B, w, h, radius, eps) {
  const N = w * h;
  const tmp = new Float32Array(N), prod = new Float32Array(N);
  const mean = (src) => {
    const out = new Float32Array(N);
    boxMean(src, w, h, radius, out, tmp);
    return out;
  };
  const meanProd = (a, b) => {
    for (let i = 0; i < N; i++) prod[i] = a[i] * b[i];
    return mean(prod);
  };

  const mR = mean(R), mG = mean(G), mB = mean(B), mP = mean(p);
  const rr = meanProd(R, R), rg = meanProd(R, G), rb = meanProd(R, B);
  const gg = meanProd(G, G), gb = meanProd(G, B), bb = meanProd(B, B);
  const rp = meanProd(R, p), gp = meanProd(G, p), bp = meanProd(B, p);

  const aR = new Float32Array(N), aG = new Float32Array(N), aB = new Float32Array(N), b = new Float32Array(N);
  const flat = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const vrr = rr[i] - mR[i] * mR[i], vrg = rg[i] - mR[i] * mG[i], vrb = rb[i] - mR[i] * mB[i];
    const vgg = gg[i] - mG[i] * mG[i], vgb = gb[i] - mG[i] * mB[i], vbb = bb[i] - mB[i] * mB[i];
    const cr = rp[i] - mR[i] * mP[i], cg = gp[i] - mG[i] * mP[i], cb = bp[i] - mB[i] * mP[i];

    const a11 = vrr + eps, a22 = vgg + eps, a33 = vbb + eps;
    const c11 = a22 * a33 - vgb * vgb;
    const c12 = vrb * vgb - vrg * a33;
    const c13 = vrg * vgb - vrb * a22;
    const c22 = a11 * a33 - vrb * vrb;
    const c23 = vrb * vrg - a11 * vgb;
    const c33 = a11 * a22 - vrg * vrg;
    const det = a11 * c11 + vrg * c12 + vrb * c13;

    const ar = (c11 * cr + c12 * cg + c13 * cb) / det;
    const ag = (c12 * cr + c22 * cg + c23 * cb) / det;
    const ab = (c13 * cr + c23 * cg + c33 * cb) / det;
    aR[i] = ar; aG[i] = ag; aB[i] = ab;
    b[i] = mP[i] - ar * mR[i] - ag * mG[i] - ab * mB[i];

    // Vùng ảnh phẳng không có biên màu để bám: tin mặt nạ AI thay vì làm nhòe nó
    const variance = vrr + vgg + vbb;
    flat[i] = 8e-4 / (variance + 8e-4);
  }

  const out = { aR: mean(aR), aG: mean(aG), aB: mean(aB), b: mean(b), flat: mean(flat) };
  return out;
}

/** Alpha tại một điểm thuộc dải viền, từ hệ số guided filter và mặt nạ AI. */
function bandAlpha(pv, u, ar, ag, ab, b, flat, r, g, b2) {
  let q = ar * r + ag * g + ab * b2 + b;
  q = q * (1 - flat) + pv * flat;
  // Guided filter chỉ được dịch alpha trong phạm vi AI còn phân vân
  const span = 0.04 + 0.96 * 4 * pv * (1 - pv);
  if (q < pv - span) q = pv - span;
  else if (q > pv + span) q = pv + span;
  // Hòa dần về mặt nạ ở mép ngoài dải viền để không tạo vòng tròn
  const blend = u >= 0.12 ? 1 : u / 0.12;
  return curve(q * blend + pv * (1 - blend));
}

/**
 * Ước lượng màu tiền cảnh thật tại viền bán trong suốt (Fast Multi-Level Foreground
 * Estimation, Germer et al. 2020). Giải I = αF + (1-α)B từ thô đến mịn.
 */
export function estimateForeground(R, G, B, alpha, w, h) {
  const nLevels = Math.ceil(Math.log2(Math.max(w, h, 2)));
  const src = [R, G, B];
  const N = w * h;

  let meanF = [0, 0, 0], meanB = [0, 0, 0], cF = 0, cB = 0;
  for (let i = 0; i < N; i++) {
    if (alpha[i] > 0.9) { cF++; for (let c = 0; c < 3; c++) meanF[c] += src[c][i]; }
    else if (alpha[i] < 0.1) { cB++; for (let c = 0; c < 3; c++) meanB[c] += src[c][i]; }
  }
  meanF = meanF.map((v) => v / Math.max(1, cF));
  meanB = meanB.map((v) => v / Math.max(1, cB));

  let pw = 1, ph = 1;
  let F = Float32Array.from(meanF), Bg = Float32Array.from(meanB);

  for (let level = 0; level <= nLevels; level++) {
    const lw = Math.max(1, Math.round(Math.pow(w, level / nLevels)));
    const lh = Math.max(1, Math.round(Math.pow(h, level / nLevels)));
    const count = lw * lh;
    const A = new Float32Array(count);
    const I = new Float32Array(count * 3);
    const nF = new Float32Array(count * 3);
    const nB = new Float32Array(count * 3);

    for (let y = 0; y < lh; y++) {
      const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / lh));
      const py = Math.min(ph - 1, Math.floor((y + 0.5) * ph / lh));
      for (let x = 0; x < lw; x++) {
        const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / lw));
        const px = Math.min(pw - 1, Math.floor((x + 0.5) * pw / lw));
        const si = sy * w + sx, pi = (py * pw + px) * 3, di = y * lw + x;
        A[di] = alpha[si];
        for (let c = 0; c < 3; c++) {
          I[di * 3 + c] = src[c][si];
          nF[di * 3 + c] = F[pi + c];
          nB[di * 3 + c] = Bg[pi + c];
        }
      }
    }

    const iterations = lw <= 32 && lh <= 32 ? 10 : 2;
    const isTop = level === nLevels;
    for (let it = 0; it < iterations; it++) {
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++) {
          const idx = y * lw + x;
          const a0 = A[idx];
          // Ở lớp cao nhất, vùng đặc hoàn toàn không cần giải
          if (isTop && a0 >= 1) {
            for (let c = 0; c < 3; c++) nF[idx * 3 + c] = I[idx * 3 + c];
            continue;
          }
          const a1 = 1 - a0;
          const west = x > 0 ? idx - 1 : idx, east = x < lw - 1 ? idx + 1 : idx;
          const north = y > 0 ? idx - lw : idx, south = y < lh - 1 ? idx + lw : idx;
          const wW = 1e-5 + Math.abs(a0 - A[west]), wE = 1e-5 + Math.abs(a0 - A[east]);
          const wN = 1e-5 + Math.abs(a0 - A[north]), wS = 1e-5 + Math.abs(a0 - A[south]);
          const sumW = wW + wE + wN + wS;

          const m00 = a0 * a0 + sumW, m01 = a0 * a1, m11 = a1 * a1 + sumW;
          const det = m00 * m11 - m01 * m01;
          const inv00 = m11 / det, inv01 = -m01 / det, inv11 = m00 / det;

          for (let c = 0; c < 3; c++) {
            const i3 = I[idx * 3 + c];
            const b0 = a0 * i3 + wW * nF[west * 3 + c] + wE * nF[east * 3 + c] + wN * nF[north * 3 + c] + wS * nF[south * 3 + c];
            const b1 = a1 * i3 + wW * nB[west * 3 + c] + wE * nB[east * 3 + c] + wN * nB[north * 3 + c] + wS * nB[south * 3 + c];
            nF[idx * 3 + c] = clip01(inv00 * b0 + inv01 * b1);
            nB[idx * 3 + c] = clip01(inv01 * b0 + inv11 * b1);
          }
        }
      }
    }
    F = nF; Bg = nB; pw = lw; ph = lh;
  }
  return F;
}

/**
 * Hàm chính. Ghi alpha (và màu viền đã khử nhiễm) trực tiếp vào `full`.
 * @param layers  [{mask: Float32Array 0..1, w, h, rect?}] – lớp 0 phủ toàn ảnh
 * @param guide   RGBA của ảnh đã thu về gw×gh
 * @param full    RGBA của ảnh gốc W×H
 */
export function refine({ layers, guide, gw, gh, full, W, H }) {
  const N = gw * gh;
  const { R, G, B } = splitChannels(guide, N);

  let p = composeLayers(layers, gw, gh);
  p = removeStrayIslands(p, gw, gh);
  p = softenCastShadow(p, R, G, B, gw, gh);

  const scale = Math.max(gw, gh) / 1024;
  const radius = Math.max(3, Math.round(3 * scale));
  const coef = colorGuidedFilter(p, R, G, B, gw, gh, radius, 2e-4);

  // Dải viền: quanh mọi điểm AI còn phân vân
  const unsure = new Float32Array(N), tmp = new Float32Array(N), u = new Float32Array(N);
  for (let i = 0; i < N; i++) unsure[i] = p[i] > SURE_LOW && p[i] < SURE_HIGH ? 1 : 0;
  boxMean(unsure, gw, gh, Math.max(2, Math.round(radius * 0.75)), u, tmp);

  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    alpha[i] = u[i] > 0
      ? bandAlpha(p[i], u[i], coef.aR[i], coef.aG[i], coef.aB[i], coef.b[i], coef.flat[i], R[i], G[i], B[i])
      : curve(p[i]);
  }

  // Khử màu nền: chỉ lưu phần chênh ΔF, để ảnh gốc giữ nguyên chi tiết khi áp lên W×H
  const F = estimateForeground(R, G, B, alpha, gw, gh);
  const dR = new Float32Array(N), dG = new Float32Array(N), dB = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (alpha[i] >= 1) continue;
    dR[i] = F[i * 3] - R[i];
    dG[i] = F[i * 3 + 1] - G[i];
    dB[i] = F[i * 3 + 2] - B[i];
  }

  const x0s = new Int32Array(W), x1s = new Int32Array(W), fxs = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const sx = Math.min(gw - 1, Math.max(0, (x + 0.5) * gw / W - 0.5));
    x0s[x] = Math.floor(sx);
    x1s[x] = Math.min(gw - 1, x0s[x] + 1);
    fxs[x] = sx - x0s[x];
  }

  let a = 0, b = 0, c = 0, d = 0, fx = 0, fy = 0;
  const lerp = (arr) => (arr[a] * (1 - fx) + arr[b] * fx) * (1 - fy) + (arr[c] * (1 - fx) + arr[d] * fx) * fy;

  for (let y = 0; y < H; y++) {
    const sy = Math.min(gh - 1, Math.max(0, (y + 0.5) * gh / H - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(gh - 1, y0 + 1), yFrac = sy - y0;
    const r0 = y0 * gw, r1 = y1 * gw;
    fy = yFrac;
    let i = y * W * 4;

    for (let x = 0; x < W; x++, i += 4) {
      fx = fxs[x];
      a = r0 + x0s[x]; b = r0 + x1s[x]; c = r1 + x0s[x]; d = r1 + x1s[x];

      const pv = lerp(p);
      let q;
      if (u[a] > 0 || u[b] > 0 || u[c] > 0 || u[d] > 0) {
        q = bandAlpha(pv, lerp(u), lerp(coef.aR), lerp(coef.aG), lerp(coef.aB), lerp(coef.b), lerp(coef.flat),
          full[i] / 255, full[i + 1] / 255, full[i + 2] / 255);
        if (q < 1) {
          // Uint8ClampedArray tự giới hạn 0..255
          full[i] += lerp(dR) * 255;
          full[i + 1] += lerp(dG) * 255;
          full[i + 2] += lerp(dB) * 255;
        }
      } else {
        q = curve(pv);
      }
      full[i + 3] = Math.round(q * full[i + 3]);
    }
  }
}
