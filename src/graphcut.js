/**
 * graphcut.js – QUYẾT ĐỊNH VÙNG AI CÒN PHÂN VÂN BẰNG MÀU SẮC ẢNH (GRABCUT)
 * ----------------------------------------------------------------------------
 * Mô hình đôi khi chỉ tin 30-50% vào một phần của chủ thể, ví dụ chiếc lá hay viền
 * giấy của sticker. Ngưỡng theo từng điểm sẽ làm vùng đó mờ hoặc biến mất.
 * Graph cut xét cả vùng cùng lúc: học phân bố màu của tiền cảnh và nền từ những điểm
 * AI đã chắc chắn, rồi tìm đường cắt bám theo biên màu thật của ảnh.
 */

const K = 5;
const GAMMA = 50;

export const LABEL = { BG: 0, FG: 1, PROBABLE_BG: 2, PROBABLE_FG: 3 };

/** Bộ sinh số ngẫu nhiên có seed: cùng một ảnh luôn cho cùng một kết quả. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mô hình hỗn hợp Gauss 5 thành phần trên không gian RGB. */
class GMM {
  constructor() {
    this.coef = new Float64Array(K);
    this.mean = new Float64Array(K * 3);
    this.inv = new Float64Array(K * 9);
    this.det = new Float64Array(K);
  }

  /** Xác suất của màu (r,g,b) theo một thành phần. */
  component(c, r, g, b) {
    if (this.coef[c] <= 0) return 0;
    const m = c * 3, i = c * 9, v = this.inv;
    const dr = r - this.mean[m], dg = g - this.mean[m + 1], db = b - this.mean[m + 2];
    const q = dr * (dr * v[i] + dg * v[i + 3] + db * v[i + 6])
      + dg * (dr * v[i + 1] + dg * v[i + 4] + db * v[i + 7])
      + db * (dr * v[i + 2] + dg * v[i + 5] + db * v[i + 8]);
    return Math.exp(-0.5 * q) / Math.sqrt(this.det[c]);
  }

  density(r, g, b) {
    let sum = 0;
    for (let c = 0; c < K; c++) if (this.coef[c] > 0) sum += this.coef[c] * this.component(c, r, g, b);
    return sum;
  }

  best(r, g, b) {
    let bestC = 0, bestV = -1;
    for (let c = 0; c < K; c++) {
      const v = this.component(c, r, g, b);
      if (v > bestV) { bestV = v; bestC = c; }
    }
    return bestC;
  }

  /** Học lại tham số từ các điểm đã gán thành phần. */
  learn(rgb, indices, comps) {
    const n = new Float64Array(K), sum = new Float64Array(K * 3), prod = new Float64Array(K * 9);
    for (let s = 0; s < indices.length; s++) {
      const i = indices[s] * 3, c = comps[s];
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      n[c]++;
      sum[c * 3] += r; sum[c * 3 + 1] += g; sum[c * 3 + 2] += b;
      const p = c * 9;
      prod[p] += r * r; prod[p + 1] += r * g; prod[p + 2] += r * b;
      prod[p + 3] += g * r; prod[p + 4] += g * g; prod[p + 5] += g * b;
      prod[p + 6] += b * r; prod[p + 7] += b * g; prod[p + 8] += b * b;
    }

    const total = indices.length;
    for (let c = 0; c < K; c++) {
      if (n[c] === 0) { this.coef[c] = 0; continue; }
      this.coef[c] = n[c] / total;
      const mr = sum[c * 3] / n[c], mg = sum[c * 3 + 1] / n[c], mb = sum[c * 3 + 2] / n[c];
      this.mean[c * 3] = mr; this.mean[c * 3 + 1] = mg; this.mean[c * 3 + 2] = mb;
      const p = c * 9;
      const a00 = prod[p] / n[c] - mr * mr, a01 = prod[p + 1] / n[c] - mr * mg, a02 = prod[p + 2] / n[c] - mr * mb;
      const a11 = prod[p + 4] / n[c] - mg * mg, a12 = prod[p + 5] / n[c] - mg * mb, a22 = prod[p + 8] / n[c] - mb * mb;
      this.invert(c, a00, a01, a02, a11, a12, a22);
    }
  }

  invert(c, a00, a01, a02, a11, a12, a22) {
    const determinant = (d00, d11, d22) => d00 * (d11 * d22 - a12 * a12) - a01 * (a01 * d22 - a12 * a02) + a02 * (a01 * a12 - d11 * a02);
    let d00 = a00, d11 = a11, d22 = a22;
    let det = determinant(d00, d11, d22);
    if (det <= 1e-6) {
      // Thành phần gần như một màu duy nhất: thêm nhiễu nhỏ để ma trận khả nghịch
      d00 += 0.01; d11 += 0.01; d22 += 0.01;
      det = determinant(d00, d11, d22);
    }
    const c00 = d11 * d22 - a12 * a12, c01 = a02 * a12 - a01 * d22, c02 = a01 * a12 - a02 * d11;
    const c11 = d00 * d22 - a02 * a02, c12 = a01 * a02 - d00 * a12, c22 = d00 * d11 - a01 * a01;
    const v = this.inv, i = c * 9;
    v[i] = c00 / det; v[i + 1] = c01 / det; v[i + 2] = c02 / det;
    v[i + 3] = c01 / det; v[i + 4] = c11 / det; v[i + 5] = c12 / det;
    v[i + 6] = c02 / det; v[i + 7] = c12 / det; v[i + 8] = c22 / det;
    this.det[c] = det;
  }
}

/** Gán thành phần ban đầu bằng k-means++ trên một mẫu tối đa 20.000 điểm. */
function kmeansInit(rgb, indices, rand) {
  const comps = new Uint8Array(indices.length);
  const step = Math.max(1, Math.floor(indices.length / 20000));
  const sample = [];
  for (let s = 0; s < indices.length; s += step) sample.push(indices[s] * 3);

  const centers = new Float64Array(K * 3);
  const setCenter = (c, i) => { centers[c * 3] = rgb[i]; centers[c * 3 + 1] = rgb[i + 1]; centers[c * 3 + 2] = rgb[i + 2]; };
  const dist2 = (i, c) => {
    const dr = rgb[i] - centers[c * 3], dg = rgb[i + 1] - centers[c * 3 + 1], db = rgb[i + 2] - centers[c * 3 + 2];
    return dr * dr + dg * dg + db * db;
  };

  setCenter(0, sample[Math.floor(rand() * sample.length)]);
  const nearest = new Float64Array(sample.length).fill(Infinity);
  for (let c = 1; c < K; c++) {
    let total = 0;
    for (let s = 0; s < sample.length; s++) {
      const d = dist2(sample[s], c - 1);
      if (d < nearest[s]) nearest[s] = d;
      total += nearest[s];
    }
    let target = rand() * total, pick = sample.length - 1;
    for (let s = 0; s < sample.length; s++) {
      target -= nearest[s];
      if (target <= 0) { pick = s; break; }
    }
    setCenter(c, sample[pick]);
  }

  const assign = (i) => {
    let best = 0, bestD = Infinity;
    for (let c = 0; c < K; c++) {
      const d = dist2(i, c);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  };

  for (let it = 0; it < 10; it++) {
    const n = new Float64Array(K), sum = new Float64Array(K * 3);
    for (let s = 0; s < sample.length; s++) {
      const i = sample[s], c = assign(i);
      n[c]++; sum[c * 3] += rgb[i]; sum[c * 3 + 1] += rgb[i + 1]; sum[c * 3 + 2] += rgb[i + 2];
    }
    for (let c = 0; c < K; c++) {
      if (!n[c]) continue;
      centers[c * 3] = sum[c * 3] / n[c];
      centers[c * 3 + 1] = sum[c * 3 + 1] / n[c];
      centers[c * 3 + 2] = sum[c * 3 + 2] / n[c];
    }
  }
  for (let s = 0; s < indices.length; s++) comps[s] = assign(indices[s] * 3);
  return comps;
}

/**
 * Luồng cực đại Boykov-Kolmogorov. Đỉnh đánh số từ 1, cạnh theo cặp (e, e^1).
 * Số 0 ở `next` nghĩa là đỉnh không nằm trong hàng đợi.
 */
class FlowGraph {
  constructor(vertices, maxEdges) {
    this.n = vertices;
    this.nil = vertices + 1;
    this.first = new Int32Array(vertices + 2);
    this.weightV = new Float64Array(vertices + 2);
    this.dst = new Int32Array(maxEdges + 2);
    this.nextE = new Int32Array(maxEdges + 2);
    this.cap = new Float64Array(maxEdges + 2);
    this.edges = 2; // cạnh 0 và 1 để dành, vì 0 có nghĩa là "hết danh sách"
  }

  addEdge(i, j, w, rev) {
    let e = this.edges++;
    this.dst[e] = j; this.nextE[e] = this.first[i]; this.cap[e] = w; this.first[i] = e;
    e = this.edges++;
    this.dst[e] = i; this.nextE[e] = this.first[j]; this.cap[e] = rev; this.first[j] = e;
  }

  addTerminal(i, source, sink) {
    const dw = this.weightV[i];
    if (dw > 0) source += dw; else sink -= dw;
    this.weightV[i] = source - sink;
  }

  /** Trả về t: t[v] = 0 nếu đỉnh v thuộc phía nguồn (tiền cảnh). */
  solve() {
    const TERMINAL = -1, ORPHAN = -2;
    const { n, nil, first: firstE, nextE, dst, cap, weightV } = this;
    const next = new Int32Array(n + 2), parent = new Int32Array(n + 2);
    const ts = new Int32Array(n + 2), dist = new Int32Array(n + 2);
    const t = new Uint8Array(n + 2);
    const orphans = [];

    let last = nil, head = nil;
    next[nil] = nil;
    for (let v = 1; v <= n; v++) {
      if (weightV[v] !== 0) {
        next[last] = v; last = v;
        dist[v] = 1; parent[v] = TERMINAL; t[v] = weightV[v] < 0 ? 1 : 0;
      }
    }
    head = next[nil];
    next[last] = nil;
    next[nil] = 0;

    let curTs = 0;
    for (;;) {
      let e0 = -1;

      // Mở rộng hai cây tìm kiếm tới khi chúng gặp nhau
      while (head !== nil) {
        const v = head;
        if (parent[v]) {
          const vt = t[v];
          for (let ei = firstE[v]; ei !== 0; ei = nextE[ei]) {
            if (cap[ei ^ vt] === 0) continue;
            const u = dst[ei];
            if (!parent[u]) {
              t[u] = vt;
              parent[u] = ei ^ 1;
              ts[u] = ts[v];
              dist[u] = dist[v] + 1;
              if (!next[u]) { next[u] = nil; next[last] = u; last = u; }
              continue;
            }
            if (t[u] !== vt) { e0 = ei ^ vt; break; }
            if (dist[u] > dist[v] + 1 && ts[u] <= ts[v]) {
              parent[u] = ei ^ 1;
              ts[u] = ts[v];
              dist[u] = dist[v] + 1;
            }
          }
          if (e0 > 0) break;
        }
        head = next[v];
        next[v] = 0;
      }
      if (e0 <= 0) break;

      // Lượng luồng tối đa đẩy được qua đường tăng
      let minW = cap[e0];
      for (let k = 1; k >= 0; k--) {
        let v = dst[e0 ^ k], ei;
        for (;;) {
          ei = parent[v];
          if (ei < 0) break;
          if (cap[ei ^ k] < minW) minW = cap[ei ^ k];
          v = dst[ei];
        }
        const abs = Math.abs(weightV[v]);
        if (abs < minW) minW = abs;
      }

      // Đẩy luồng, cạnh bão hòa tạo ra các đỉnh mồ côi
      cap[e0] -= minW;
      cap[e0 ^ 1] += minW;
      for (let k = 1; k >= 0; k--) {
        let v = dst[e0 ^ k], ei;
        for (;;) {
          ei = parent[v];
          if (ei < 0) break;
          cap[ei ^ (k ^ 1)] += minW;
          cap[ei ^ k] -= minW;
          if (cap[ei ^ k] === 0) { orphans.push(v); parent[v] = ORPHAN; }
          v = dst[ei];
        }
        weightV[v] += minW * (1 - k * 2);
        if (weightV[v] === 0) { orphans.push(v); parent[v] = ORPHAN; }
      }

      // Tìm cha mới cho các đỉnh mồ côi
      curTs++;
      while (orphans.length) {
        const v2 = orphans.pop();
        let minDist = 0x7fffffff, bestE = 0;
        const vt = t[v2];
        for (let ei = firstE[v2]; ei !== 0; ei = nextE[ei]) {
          if (cap[ei ^ (vt ^ 1)] === 0) continue;
          let u = dst[ei];
          if (t[u] !== vt || parent[u] === 0) continue;
          let d = 0;
          for (;;) {
            if (ts[u] === curTs) { d += dist[u]; break; }
            const ej = parent[u];
            d++;
            if (ej < 0) {
              if (ej === ORPHAN) d = 0x7ffffffe;
              else { ts[u] = curTs; dist[u] = 1; }
              break;
            }
            u = dst[ej];
          }
          if (++d < 0x7fffffff) {
            if (d < minDist) { minDist = d; bestE = ei; }
            for (u = dst[ei]; ts[u] !== curTs; u = dst[parent[u]]) {
              ts[u] = curTs;
              dist[u] = --d;
            }
          }
        }
        parent[v2] = bestE;
        if (bestE > 0) {
          ts[v2] = curTs;
          dist[v2] = minDist;
          continue;
        }

        ts[v2] = 0;
        for (let ei = firstE[v2]; ei !== 0; ei = nextE[ei]) {
          const u = dst[ei], ej = parent[u];
          if (t[u] !== vt || !ej) continue;
          if (cap[ei ^ (vt ^ 1)] && !next[u]) {
            next[u] = nil; next[last] = u; last = u;
            if (head === nil) head = u;
          }
          if (ej > 0 && dst[ej] === v2) { orphans.push(u); parent[u] = ORPHAN; }
        }
      }
    }
    return t;
  }
}

/**
 * GrabCut với nhãn khởi tạo sẵn.
 * @param rgb    Uint8Array w*h*3
 * @param labels Uint8Array w*h, giá trị LABEL, được cập nhật tại chỗ
 * @returns true nếu đã chạy, false nếu thiếu mẫu tiền cảnh hoặc nền
 */
export function grabCut(rgb, labels, w, h, iterations = 4) {
  const N = w * h;
  const rand = mulberry32(0x5eed);

  // Trọng số cạnh giữa các điểm lân cận: càng khác màu thì càng dễ cắt
  let sumDiff = 0, pairs = 0;
  const diff = (a, b) => {
    const dr = rgb[a * 3] - rgb[b * 3], dg = rgb[a * 3 + 1] - rgb[b * 3 + 1], db = rgb[a * 3 + 2] - rgb[b * 3 + 2];
    return dr * dr + dg * dg + db * db;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) { sumDiff += diff(i, i - 1); pairs++; }
      if (y > 0) {
        sumDiff += diff(i, i - w); pairs++;
        if (x > 0) { sumDiff += diff(i, i - w - 1); pairs++; }
        if (x < w - 1) { sumDiff += diff(i, i - w + 1); pairs++; }
      }
    }
  }
  const beta = sumDiff > 0 ? 1 / ((2 * sumDiff) / pairs) : 0;

  // Chỉ điểm chưa chắc chắn mới là đỉnh đồ thị, để bài toán nhỏ hơn nhiều
  const vertexOf = new Int32Array(N);
  let vertices = 0;
  for (let i = 0; i < N; i++) {
    if (labels[i] === LABEL.PROBABLE_BG || labels[i] === LABEL.PROBABLE_FG) vertexOf[i] = ++vertices;
  }
  if (!vertices) return false;

  const fgGMM = new GMM(), bgGMM = new GMM();
  const isFg = (l) => l === LABEL.FG || l === LABEL.PROBABLE_FG;
  const collect = () => {
    let fg = 0, bg = 0;
    for (let i = 0; i < N; i++) if (isFg(labels[i])) fg++; else bg++;
    const fgIdx = new Int32Array(fg), bgIdx = new Int32Array(bg);
    fg = 0; bg = 0;
    for (let i = 0; i < N; i++) if (isFg(labels[i])) fgIdx[fg++] = i; else bgIdx[bg++] = i;
    return { fgIdx, bgIdx };
  };

  let { fgIdx, bgIdx } = collect();
  if (fgIdx.length < K || bgIdx.length < K) return false;
  fgGMM.learn(rgb, fgIdx, kmeansInit(rgb, fgIdx, rand));
  bgGMM.learn(rgb, bgIdx, kmeansInit(rgb, bgIdx, rand));

  const OFFSETS = [[-1, 0, 1], [-1, -1, Math.SQRT1_2], [0, -1, 1], [1, -1, Math.SQRT1_2]];

  for (let it = 0; it < iterations; it++) {
    if (it > 0) {
      ({ fgIdx, bgIdx } = collect());
      if (fgIdx.length < K || bgIdx.length < K) break;
      for (const [idx, gmm] of [[fgIdx, fgGMM], [bgIdx, bgGMM]]) {
        const comps = new Uint8Array(idx.length);
        for (let s = 0; s < idx.length; s++) {
          const i = idx[s] * 3;
          comps[s] = gmm.best(rgb[i], rgb[i + 1], rgb[i + 2]);
        }
        gmm.learn(rgb, idx, comps);
      }
    }

    const graph = new FlowGraph(vertices, vertices * 8 + 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, v = vertexOf[i];
        if (v) {
          const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
          graph.addTerminal(v,
            -Math.log(Math.max(bgGMM.density(r, g, b), 1e-300)),
            -Math.log(Math.max(fgGMM.density(r, g, b), 1e-300)));
        }
        for (const [dx, dy, scale] of OFFSETS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0) continue;
          const j = ny * w + nx, u = vertexOf[j];
          if (!v && !u) continue;
          const weight = GAMMA * scale * Math.exp(-beta * diff(i, j));
          if (v && u) {
            graph.addEdge(v, u, weight, weight);
          } else {
            // Một đầu là điểm chắc chắn: quy về nối thẳng với nguồn hoặc đích
            const free = v || u, fixed = v ? labels[j] : labels[i];
            if (fixed === LABEL.FG) graph.addTerminal(free, weight, 0);
            else graph.addTerminal(free, 0, weight);
          }
        }
      }
    }

    const side = graph.solve();
    for (let i = 0; i < N; i++) {
      const v = vertexOf[i];
      if (v) labels[i] = side[v] === 0 ? LABEL.PROBABLE_FG : LABEL.PROBABLE_BG;
    }
  }
  return true;
}
