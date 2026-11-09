/**
 * refine.core.js – BIẾN MẶT NẠ AI THÀNH ALPHA CHẤT LƯỢNG CAO Ở ĐỘ PHÂN GIẢI GỐC
 * ----------------------------------------------------------------------------
 * Nguyên tắc: AI quyết định "cái gì là chủ thể", ở đây chỉ làm đẹp đường viền.
 * Không có luật nào dựa trên màu sắc hay vị trí cố định của một loại ảnh cụ thể,
 * vì các luật như vậy luôn phá hỏng những ảnh còn lại.
 *
 * Các bước (mọi phép tính nặng chạy trên "lưới dẫn" gw×gh, ảnh gốc chỉ nội suy):
 *   1. composeLayers      Ghép mặt nạ toàn ảnh với mặt nạ soi cận chủ thể.
 *   2. decideRegions      Vùng AI còn phân vân được quyết định bằng màu ảnh (graph cut).
 *   3. removeStrayIslands Bỏ đốm rác xa chủ thể, giữ vật thể thật và chi tiết gần.
 *   4. guided filter màu  Bám alpha theo biên màu thật của ảnh trong dải viền.
 *   5. estimateForeground Khử màu nền bám ở viền bán trong suốt (Germer et al. 2020).
 *   6. Áp lên ảnh gốc W×H, giữ chi tiết tần số cao của ảnh thật.
 */
import { grabCut, LABEL } from './graphcut.js';

const REGION_GRID = 512;
const THICK_REGION = 0.015; // bán kính tối thiểu (theo cạnh ảnh) để một vùng được coi là dày
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

/** Thu nhỏ bằng trung bình vùng, tránh răng cưa của phép lấy mẫu điểm. */
function shrinkMask(mask, mw, mh, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * mh / h), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * mh / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * mw / w), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * mw / w));
      let sum = 0;
      for (let my = y0; my < y1; my++) for (let mx = x0; mx < x1; mx++) sum += mask[my * mw + mx];
      out[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Đổi kích thước một mặt nạ mw×mh về lưới w×h. */
export function resampleMask(mask, mw, mh, w, h) {
  if (mw >= w && mh >= h && (mw > w || mh > h)) return shrinkMask(mask, mw, mh, w, h);
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
    if (rw < 1 || rh < 1) continue;
    const fitted = resampleMask(mask, mw, mh, rw, rh);

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = y * gw + x;
        if (near[idx] <= 0) continue; // quá xa chủ thể: giữ nguyên lớp 0
        let v = fitted[(y - y0) * rw + (x - x0)];
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
 * cụm lớn nhất (nhiều chủ thể), hoặc có phần chắc chắn và nằm gần một cụm đã giữ
 * (khuyên tai, các chữ cái của logo). Cụm toàn điểm mờ, không dính vào đâu thì bỏ.
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
      if (l && !kept[l] && core[l] > 0 && near[i] > 0) { kept[l] = 1; changed = true; }
    }
    if (!changed) break;
  }

  for (let i = 0; i < N; i++) if (labels[i] && !kept[labels[i]]) p[i] = 0;
  return p;
}

/** Khoảng cách chamfer tới điểm hạt gần nhất (seed[i] != 0). */
function distanceToSeeds(seed, w, h) {
  const N = w * h;
  const dist = new Float32Array(N);
  const INF = w + h;
  for (let i = 0; i < N; i++) dist[i] = seed[i] ? 0 : INF;

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
  return dist;
}

/**
 * Khi graph cut vừa khẳng định một vùng dày mà AI từng phân vân (ví dụ chiếc lá), phần
 * tiếp theo của vùng đó có thể bị AI chấm gần 0 (mũi lá, viền giấy bao quanh lá).
 * Chỉ quanh những vùng như vậy mới mở khóa nhãn "chắc chắn là nền" rồi cắt lại.
 * Dải viền mỏng quanh chủ thể không tính, nên bóng dưới gầm xe vẫn bị loại.
 * @returns vùng đã mở khóa, hoặc null nếu ảnh không có vùng dày nào như vậy
 */
function expandPromotedRegions(rgb, labels, small, w, h) {
  const n = w * h;
  const promoted = new Float32Array(n), core = new Float32Array(n), tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const fg = labels[i] === LABEL.FG || labels[i] === LABEL.PROBABLE_FG;
    promoted[i] = fg && small[i] < 0.9 ? 1 : 0;
  }
  boxMean(promoted, w, h, Math.max(2, Math.round(Math.max(w, h) * THICK_REGION)), core, tmp);

  let coreArea = 0;
  for (let i = 0; i < n; i++) {
    core[i] = core[i] >= 0.999 ? 1 : 0;
    coreArea += core[i];
  }
  if (coreArea < n * 0.0015) return null;

  const side = Math.max(w, h);
  const zone = new Float32Array(n), grown = new Float32Array(n), gained = new Float32Array(n);
  boxMean(core, w, h, Math.max(4, Math.round(side * 0.08)), zone, tmp);
  for (let i = 0; i < n; i++) zone[i] = zone[i] > 0 ? 1 : 0;

  // Mở rộng từng bước theo phần vừa giành được, để đi hết những đoạn thuôn như mũi lá
  const opened = new Uint8Array(n);
  for (let round = 1; round <= 3; round++) {
    let fresh = 0;
    for (let i = 0; i < n; i++) {
      if (zone[i] > 0 && labels[i] === LABEL.BG) { labels[i] = LABEL.PROBABLE_BG; opened[i] = round; fresh++; }
    }
    if (!fresh) break;
    grabCut(rgb, labels, w, h, 3);

    let won = 0;
    for (let i = 0; i < n; i++) {
      gained[i] = opened[i] === round && labels[i] === LABEL.PROBABLE_FG ? 1 : 0;
      won += gained[i];
    }
    if (!won) break;
    boxMean(gained, w, h, Math.max(3, Math.round(side * 0.04)), grown, tmp);
    for (let i = 0; i < n; i++) if (grown[i] > 0) zone[i] = 1;
  }
  return zone;
}

/**
 * Mảnh tiền cảnh mà AI không tin chắc và không dính liền với phần AI đã chắc chắn
 * chỉ là vật nền trùng màu. Mảnh AI tin từ 60% trở lên thì vẫn giữ (nhiều chủ thể).
 */
function dropDetached(labels, small, w, h) {
  const n = w * h;
  const reached = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  for (let i = 0; i < n; i++) if (labels[i] === LABEL.FG) { reached[i] = 1; stack[sp++] = i; }
  while (sp > 0) {
    const cur = stack[--sp], x = cur % w;
    for (const next of [x > 0 ? cur - 1 : -1, x < w - 1 ? cur + 1 : -1, cur - w, cur + w]) {
      if (next < 0 || next >= n || reached[next] || labels[next] !== LABEL.PROBABLE_FG) continue;
      reached[next] = 1;
      stack[sp++] = next;
    }
  }
  for (let i = 0; i < n; i++) {
    if (labels[i] === LABEL.PROBABLE_FG && !reached[i] && small[i] < 0.6) labels[i] = LABEL.BG;
  }
}

/**
 * Quyết định các vùng AI còn phân vân bằng graph cut trên lưới nhỏ.
 * Điểm AI gần như chắc chắn là nền (p < 0.02) không bao giờ được thành tiền cảnh,
 * nhờ đó bóng tối dưới gầm xe hay nền tối gần tóc đen không bị kéo vào chủ thể.
 */
export function decideRegions(p, guide, gw, gh) {
  const k = Math.min(1, REGION_GRID / Math.max(gw, gh));
  const sw = Math.max(1, Math.round(gw * k)), sh = Math.max(1, Math.round(gh * k));
  if (sw < 8 || sh < 8) return p;

  const n = sw * sh;
  const rgb = new Uint8Array(n * 3), small = new Float32Array(n);
  for (let sy = 0; sy < sh; sy++) {
    const y0 = Math.floor(sy * gh / sh), y1 = Math.max(y0 + 1, Math.floor((sy + 1) * gh / sh));
    for (let sx = 0; sx < sw; sx++) {
      const x0 = Math.floor(sx * gw / sw), x1 = Math.max(x0 + 1, Math.floor((sx + 1) * gw / sw));
      let r = 0, g = 0, b = 0, sum = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * gw + x;
          r += guide[i * 4]; g += guide[i * 4 + 1]; b += guide[i * 4 + 2]; sum += p[i]; count++;
        }
      }
      const d = sy * sw + sx;
      rgb[d * 3] = r / count; rgb[d * 3 + 1] = g / count; rgb[d * 3 + 2] = b / count;
      small[d] = sum / count;
    }
  }

  const soft = new Float32Array(n), near = new Float32Array(n), tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) soft[i] = small[i] >= 0.08 ? 1 : 0;
  boxMean(soft, sw, sh, Math.max(3, Math.round(Math.max(sw, sh) * 0.05)), near, tmp);

  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (near[i] <= 0 || small[i] < 0.02) labels[i] = LABEL.BG;
    else if (small[i] >= 0.9) labels[i] = LABEL.FG;
    else labels[i] = small[i] >= 0.08 ? LABEL.PROBABLE_FG : LABEL.PROBABLE_BG;
  }
  if (!grabCut(rgb, labels, sw, sh)) return p;
  const zone = expandPromotedRegions(rgb, labels, small, sw, sh);
  dropDetached(labels, small, sw, sh);

  const isFg = new Float32Array(n);
  for (let i = 0; i < n; i++) isFg[i] = labels[i] === LABEL.FG || labels[i] === LABEL.PROBABLE_FG ? 1 : 0;
  const cut = resampleMask(isFg, sw, sh, gw, gh);
  const inZone = zone ? resampleMask(zone, sw, sh, gw, gh) : null;

  // Đường cắt nằm trên lưới nhỏ nên bị răng cưa: làm mềm để guided filter còn chỗ bám biên thật
  const blurred = new Float32Array(gw * gh), cutSoft = new Float32Array(gw * gh), work = new Float32Array(gw * gh);
  const blurR = Math.max(1, Math.round(0.75 * (gw / sw)));
  boxMean(cut, gw, gh, blurR, blurred, work);
  boxMean(blurred, gw, gh, blurR, cutSoft, work);

  const N = gw * gh;
  const fgSeed = new Uint8Array(N), bgSeed = new Uint8Array(N);
  for (let i = 0; i < N; i++) { if (cut[i] >= 0.5) fgSeed[i] = 1; else bgSeed[i] = 1; }
  const toFg = distanceToSeeds(fgSeed, gw, gh), toBg = distanceToSeeds(bgSeed, gw, gh);

  const inner = Math.max(2, 2.5 * (gw / sw));
  const margin = Math.max(3, Math.max(gw, gh) * 0.015);
  for (let i = 0; i < N; i++) {
    const v = p[i];
    if (cut[i] >= 0.5) {
      // Ngoài vùng dày (tóc, lông) giữ nguyên độ mềm của AI để không lấp khe giữa các sợi
      if (!inZone || inZone[i] < 0.5) continue;
      // Lõi vùng tiền cảnh thì đặc hẳn; sát đường cắt thì tin AI nếu AI chắc chắn
      if (toBg[i] >= inner) p[i] = 1;
      else {
        const sure = clip01((Math.abs(2 * v - 1) - 0.3) / 0.6);
        p[i] = sure * v + (1 - sure) * cutSoft[i];
      }
    } else {
      // Vùng dày đã có đường cắt rõ: phần ngoài là nền hẳn, nếu giữ lại sẽ thành quầng mờ
      if (inZone && inZone[i] >= 0.5) p[i] = cutSoft[i];
      // Còn lại giữ phần mềm sát chủ thể (tóc, lông), xa dần thì về 0
      else p[i] = v * clip01(1 - toFg[i] / margin);
    }
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
  p = decideRegions(p, guide, gw, gh);
  p = removeStrayIslands(p, gw, gh);

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
