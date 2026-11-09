/**
 * main.js – ĐIỀU PHỐI TOÀN BỘ ỨNG DỤNG UYCUT AI 3.0
 * ----------------------------------------------------------------------------
 * Luồng xử lý cho mỗi ảnh:
 *   File ──decodeImage()──► canvas gốc W×H
 *        ──predictMask()──► mặt nạ AI SOTA (RMBG-1.4 hoặc BiRefNet Lite) với Letterbox 1:1
 *        ──refine worker──► canvas kết quả W×H có alpha chuẩn (Solid Subject Protection + Deshadow + Trim)
 *        ──Magic Wand / Brush──► Xóa thông minh 1 chạm hoặc quét cọ thủ công 60fps
 *        ──exportBlob()───► file PNG / WebP / JPG giữ trọn 100% độ phân giải gốc
 */
import './style.css';
import { decodeImage, makeCanvas } from './decode.js';
import { predictMask, resizeHQ, AI_SIZE } from './segment.js';

const GUIDE_MAX = 1536;

// ---------------------------------------------------------------- DOM ELEMENTS
const $ = (id) => document.getElementById(id);
const els = {
  drop: $('dropzone'), input: $('fileInput'), model: $('modelSelect'),
  keepMain: $('keepMainToggle'), refine: $('refineToggle'), deshadow: $('deshadowToggle'),
  autoRbg: $('autoRbgBtn'), stripSticker: $('stripStickerBtn'), resetBorder: $('resetBorderBtn'),
  trim: $('trimRange'), trimVal: $('trimVal'),
  radius: $('radiusRange'), low: $('lowRange'), high: $('highRange'),
  thresh: $('threshRange'), threshVal: $('threshVal'),
  radiusVal: $('radiusVal'), lowVal: $('lowVal'), highVal: $('highVal'),
  bgOptions: $('bgOptions'), bgColor: $('bgColor'), format: $('formatSelect'),
  empty: $('emptyState'), viewer: $('viewer'), meta: $('metaInfo'),
  download: $('downloadBtn'), rerun: $('rerunBtn'), compare: $('compare'),
  beforeSlot: $('beforeSlot'), afterWrap: $('afterWrap'), divider: $('divider'),
  overlay: $('overlay'), overlayText: $('overlayText'), bar: $('progressBar'),
  queue: $('queue'), queueHead: $('queueHead'), downloadAll: $('downloadAllBtn'), clear: $('clearAllBtn'),
  stageHint: $('stageHint'),
  // Bộ công cụ Studio
  modeCompare: $('modeCompareBtn'), modeWand: $('modeWandBtn'),
  modeRestore: $('modeRestoreBtn'), modeErase: $('modeEraseBtn'),
  brushParams: $('brushParams'),
  brushSizeWrap: $('brushSizeWrap'), brushSize: $('brushSizeRange'), brushSizeVal: $('brushSizeVal'),
  wandTolWrap: $('wandTolWrap'), wandTol: $('wandTolRange'), wandTolVal: $('wandTolVal'),
  undoBtn: $('undoBtn'), resetBrushBtn: $('resetBrushBtn'), brushCursor: $('brushCursor'),
};

// ---------------------------------------------------------------- TRẠNG THÁI
/** @type {Array<any>} */
const items = [];
let selected = null;
let background = 'transparent';
let seq = 0;
let currentTool = 'compare'; // 'compare' | 'wand' | 'restore' | 'erase'
let isBrushing = false;

const STATUS = {
  queued: 'Đang chờ', decoding: 'Đang đọc ảnh', ai: 'AI đang bóc tách',
  refine: 'Tinh chỉnh viền', done: 'Hoàn tất', error: 'Lỗi',
};

// ---------------------------------------------------------------- WEB WORKER
const worker = new Worker(new URL('./refine.worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let reqId = 0;

worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.error ? p.reject(new Error(data.error)) : p.resolve(data);
};

function runWorker(payload, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...payload }, transfer);
  });
}

function getParams() {
  const t = +els.thresh.value / 100; // 0.1 .. 0.9 (mặc định 0.5)
  const delta = (0.5 - t) * 0.35;
  const lowOffset = +els.low.value / 100;
  const highOffset = +els.high.value / 100;
  const low = Math.max(0.04, Math.min(0.45, lowOffset + delta));
  const high = Math.max(0.55, Math.min(1, highOffset + delta));

  return {
    keepMain: els.keepMain ? els.keepMain.checked : true,
    refine: els.refine.checked,
    deshadow: els.deshadow ? els.deshadow.checked : true,
    trim: +els.trim.value,
    radius: +els.radius.value,
    low,
    high,
  };
}

// ---------------------------------------------------------------- XỬ LÝ 1 ẢNH
async function refineItem(item) {
  const { W, H } = item;
  const full = item.orig.getContext('2d').getImageData(0, 0, W, H).data;
  const res = await runWorker(
    { mask: item.mask, maskSize: AI_SIZE, guide: item.guide.data, gw: item.gw, gh: item.gh, full, W, H, params: getParams() },
    [full.buffer],
  );
  if (!item.result) item.result = makeCanvas(W, H);
  item.result.getContext('2d').putImageData(new ImageData(res.full, W, H), 0, 0);

  // Lưu bản snapshot AI ban đầu để có thể Reset khi dùng Cọ / Đũa thần
  item.aiSnapshot = makeCanvas(W, H);
  item.aiSnapshot.getContext('2d').drawImage(item.result, 0, 0);
  item.undoStack = [];
  if (item === selected) els.undoBtn.disabled = true;

  item.refineMs = res.ms;
  item.dirty = false;
}

async function runAI(item) {
  setStatus(item, 'ai');
  const t = performance.now();
  item.mask = await predictMask(item.orig, els.model.value, (label, ratio) => {
    if (item === selected) showOverlay(label, ratio);
  });
  item.aiMs = performance.now() - t;
  item.model = els.model.value;
}

async function processItem(item) {
  try {
    setStatus(item, 'decoding');
    const { canvas, width, height, format } = await decodeImage(item.file);
    Object.assign(item, { orig: canvas, W: width, H: height, format, undoStack: [] });
    item.thumb.src = resizeHQ(canvas, ...fit(width, height, 120)).toDataURL();

    const [gw, gh] = fit(width, height, GUIDE_MAX);
    Object.assign(item, { gw, gh });
    item.guide = resizeHQ(canvas, gw, gh).getContext('2d').getImageData(0, 0, gw, gh);
    if (item === selected) renderViewer();

    await runAI(item);

    setStatus(item, 'refine');
    await refineItem(item);
    setStatus(item, 'done');
    item.thumb.src = resizeHQ(item.result, ...fit(width, height, 120)).toDataURL();
  } catch (err) {
    console.error(err);
    item.error = err.message || String(err);
    setStatus(item, 'error');
  }
  if (item === selected) renderViewer();
  updateBulkButtons();
}

let running = false;
async function pump() {
  if (running) return;
  running = true;
  let next;
  while ((next = items.find((i) => i.status === 'queued'))) await processItem(next);
  running = false;
}

function fit(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

// ---------------------------------------------------------------- THÊM ẢNH
function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.size > 0);
  if (!files.length) return;
  for (const file of files) {
    const item = {
      id: ++seq,
      file,
      name: file.name,
      size: file.size,
      status: 'queued',
      orig: null,
      result: null,
      mask: null,
      thumb: new Image(),
      undoStack: [],
    };
    items.push(item);
    renderQueueItem(item);
  }
  if (!selected) selectItem(items[items.length - files.length]);
  els.queueHead.classList.remove('hidden');
  updateBulkButtons();
  pump();
}

// ---------------------------------------------------------------- HÀNG ĐỢI
function renderQueueItem(it) {
  const li = document.createElement('li');
  li.className = 'q-item';
  li.id = `q-${it.id}`;
  li.innerHTML = `
    <div class="q-thumb checker"><img alt="${it.name}" /></div>
    <div class="q-info">
      <b title="${it.name}">${it.name}</b>
      <small>${(it.size / 1024 / 1024).toFixed(2)} MB</small>
    </div>
    <span class="q-badge" data-s="${it.status}">${STATUS[it.status]}</span>
    <button class="q-dl" title="Tải ảnh này" disabled>⬇</button>
    <button class="q-rm" title="Xóa khỏi danh sách">✕</button>
  `;
  const img = li.querySelector('img');
  it.thumb.onload = () => { img.src = it.thumb.src; };
  if (it.thumb.src) img.src = it.thumb.src;

  li.addEventListener('click', (e) => {
    if (e.target.closest('.q-dl') || e.target.closest('.q-rm')) return;
    selectItem(it);
  });
  li.querySelector('.q-dl').addEventListener('click', (e) => {
    e.stopPropagation();
    downloadItem(it);
  });
  li.querySelector('.q-rm').addEventListener('click', (e) => {
    e.stopPropagation();
    removeItem(it);
  });
  els.queue.appendChild(li);
}

function updateQueueItem(it) {
  const li = $(`q-${it.id}`);
  if (!li) return;
  const badge = li.querySelector('.q-badge');
  badge.dataset.s = it.status;
  badge.textContent = STATUS[it.status] || it.status;
  li.querySelector('.q-dl').disabled = it.status !== 'done';
  li.classList.toggle('active', it === selected);
  if (it.thumb.src) li.querySelector('img').src = it.thumb.src;
}

function setStatus(it, status) {
  it.status = status;
  updateQueueItem(it);
  if (it === selected) renderViewer();
}

function selectItem(it) {
  selected = it;
  items.forEach((i) => updateQueueItem(i));
  renderViewer();
}

function removeItem(it) {
  const idx = items.indexOf(it);
  if (idx < 0) return;
  items.splice(idx, 1);
  $(`q-${it.id}`)?.remove();
  if (selected === it) selectItem(items[idx] || items[idx - 1] || null);
  if (!items.length) {
    els.queueHead.classList.add('hidden');
    els.viewer.classList.add('hidden');
    els.empty.classList.remove('hidden');
  }
  updateBulkButtons();
}

function updateBulkButtons() {
  const hasDone = items.some((i) => i.status === 'done');
  els.downloadAll.disabled = !hasDone;
}

// ---------------------------------------------------------------- XEM & SO SÁNH
function renderViewer() {
  const it = selected;
  if (!it || !it.orig) {
    els.viewer.classList.add('hidden');
    els.empty.classList.remove('hidden');
    return;
  }
  els.empty.classList.add('hidden');
  els.viewer.classList.remove('hidden');

  const parts = [
    `<b>${it.name}</b>`,
    `Gốc: ${it.W}×${it.H}px`,
  ];
  if (it.result) parts.push(`Kết quả: <span style="color:var(--ok)">${it.W}×${it.H}px ✓</span>`);
  if (it.model) parts.push(`Mô hình: ${it.model}`);
  if (it.aiMs) parts.push(`AI ${(it.aiMs / 1000).toFixed(1)}s`);
  if (it.refineMs) parts.push(`viền ${Math.round(it.refineMs)}ms`);
  els.meta.innerHTML = parts.join(' · ');

  els.download.disabled = it.status !== 'done';
  els.rerun.disabled = !it.mask || ['decoding', 'ai', 'refine'].includes(it.status);
  els.undoBtn.disabled = !it.undoStack?.length;

  els.beforeSlot.innerHTML = '';
  els.beforeSlot.appendChild(it.orig);

  els.afterWrap.innerHTML = '';
  if (it.result) els.afterWrap.appendChild(it.result);

  if (currentTool === 'compare') {
    setSplit(50);
  } else {
    els.afterWrap.style.clipPath = 'none';
  }

  it.status === 'done' || it.status === 'error' ? hideOverlay() : null;
}

function showOverlay(text, ratio) {
  els.overlay.classList.remove('hidden');
  els.overlayText.textContent = text;
  els.bar.parentElement.classList.toggle('indeterminate', ratio == null);
  els.bar.style.width = ratio == null ? '' : `${Math.round(ratio * 100)}%`;
}
function hideOverlay() { els.overlay.classList.add('hidden'); }

// ---------------------------------------------------------------- THANH KÉO SO SÁNH
function setSplit(pct) {
  pct = Math.max(0, Math.min(100, pct));
  els.afterWrap.style.clipPath = `inset(0 0 0 ${pct}%)`;
  els.divider.style.left = `${pct}%`;
}
let dragging = false;
const moveSplit = (e) => {
  const r = els.compare.getBoundingClientRect();
  setSplit(((e.clientX - r.left) / r.width) * 100);
};

// ---------------------------------------------------------------- STUDIO TOUCH-UP (WAND & BRUSH)
function setTool(tool) {
  currentTool = tool;
  els.modeCompare.classList.toggle('active', tool === 'compare');
  els.modeWand.classList.toggle('active', tool === 'wand');
  els.modeRestore.classList.toggle('active', tool === 'restore');
  els.modeErase.classList.toggle('active', tool === 'erase');

  els.compare.classList.toggle('brush-mode', tool === 'restore' || tool === 'erase');
  els.compare.classList.toggle('wand-mode', tool === 'wand');

  els.brushSizeWrap.classList.toggle('hidden', tool === 'compare' || tool === 'wand');
  els.wandTolWrap.classList.toggle('hidden', tool !== 'wand');

  if (tool === 'compare') {
    els.brushCursor.classList.add('hidden');
    els.stageHint.innerHTML = 'Kéo thanh giữa để so sánh <b>Trước</b> / <b>Sau</b>.';
    setSplit(50);
  } else if (tool === 'wand') {
    els.brushCursor.classList.add('hidden');
    els.afterWrap.style.clipPath = 'none';
    els.stageHint.innerHTML = '🪄 Bấm <b>1 nhấp</b> vào vùng bóng đổ, chữ hoặc chi tiết thừa để xóa thông minh tức thì.';
  } else {
    els.afterWrap.style.clipPath = 'none';
    els.stageHint.innerHTML = 'Quét cọ trên ảnh để chỉnh sửa trực tiếp trên độ phân giải gốc.';
    updateBrushCursorSize();
  }
}

function updateBrushCursorSize() {
  const size = +els.brushSize.value;
  els.brushSizeVal.textContent = size + 'px';
  els.brushCursor.style.width = size + 'px';
  els.brushCursor.style.height = size + 'px';
}

function updateWandTol() {
  els.wandTolVal.textContent = els.wandTol.value;
}

els.modeCompare.addEventListener('click', () => setTool('compare'));
els.modeWand.addEventListener('click', () => setTool('wand'));
els.modeRestore.addEventListener('click', () => setTool('restore'));
els.modeErase.addEventListener('click', () => setTool('erase'));
els.brushSize.addEventListener('input', updateBrushCursorSize);
els.wandTol.addEventListener('input', updateWandTol);

function getCanvasCoords(e) {
  const canvas = els.beforeSlot.querySelector('canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const scaleX = selected.W / rect.width;
  const scaleY = selected.H / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  const radius = (+els.brushSize.value / 2) * Math.max(scaleX, scaleY);
  return { x, y, radius, px: Math.round(x), py: Math.round(y) };
}

function saveUndo() {
  if (!selected.undoStack) selected.undoStack = [];
  if (selected.undoStack.length >= 20) selected.undoStack.shift();
  const snap = makeCanvas(selected.W, selected.H);
  snap.getContext('2d').drawImage(selected.result, 0, 0);
  selected.undoStack.push(snap);
  els.undoBtn.disabled = false;
}

// 🪄 THUẬT TOÁN ĐŨA THẦN 1 CHẠM (Magic Wand Flood Erase)
function magicWandErase(startX, startY) {
  if (!selected?.result || !selected?.orig) return;
  const W = selected.W, H = selected.H;
  if (startX < 0 || startX >= W || startY < 0 || startY >= H) return;

  saveUndo();

  const origCtx = selected.orig.getContext('2d');
  const origData = origCtx.getImageData(0, 0, W, H).data;

  const resCtx = selected.result.getContext('2d');
  const resData = resCtx.getImageData(0, 0, W, H);
  const d = resData.data;

  const startIdx = (startY * W + startX) * 4;
  const sr = origData[startIdx], sg = origData[startIdx + 1], sb = origData[startIdx + 2];
  const tolerance = +els.wandTol.value;
  const tolSq = tolerance * tolerance;

  const visited = new Uint8Array(W * H);
  const queue = [startY * W + startX];
  visited[startY * W + startX] = 1;

  while (queue.length > 0) {
    const curr = queue.pop();
    const cx = curr % W, cy = Math.floor(curr / W);
    const idx = curr * 4;

    // Xóa alpha
    d[idx + 3] = 0;

    const neighbors = [
      cx > 0 ? curr - 1 : -1,
      cx < W - 1 ? curr + 1 : -1,
      cy > 0 ? curr - W : -1,
      cy < H - 1 ? curr + W : -1,
    ];

    for (const n of neighbors) {
      if (n >= 0 && !visited[n]) {
        const nIdx = n * 4;
        const dr = origData[nIdx] - sr;
        const dg = origData[nIdx + 1] - sg;
        const db = origData[nIdx + 2] - sb;
        if (dr * dr + dg * dg + db * db <= tolSq) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }
  }

  resCtx.putImageData(resData, 0, 0);
  selected.thumb.src = resizeHQ(selected.result, ...fit(W, H, 120)).toDataURL();
}

function paint(e) {
  if (!selected?.result || !selected?.orig) return;
  const coords = getCanvasCoords(e);
  if (!coords) return;
  const { x, y, radius } = coords;
  const ctx = selected.result.getContext('2d');

  if (currentTool === 'restore') {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(selected.orig, 0, 0);
    ctx.restore();
  } else if (currentTool === 'erase') {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

els.compare.addEventListener('pointerdown', (e) => {
  if (currentTool === 'compare') {
    dragging = true;
    els.compare.setPointerCapture(e.pointerId);
    moveSplit(e);
  } else if (currentTool === 'wand') {
    const coords = getCanvasCoords(e);
    if (coords) magicWandErase(coords.px, coords.py);
  } else if (selected?.result) {
    isBrushing = true;
    els.compare.setPointerCapture(e.pointerId);
    saveUndo();
    paint(e);
  }
});

els.compare.addEventListener('pointermove', (e) => {
  if (currentTool === 'compare') {
    if (dragging) moveSplit(e);
  } else if (currentTool === 'restore' || currentTool === 'erase') {
    const r = els.compare.getBoundingClientRect();
    els.brushCursor.style.left = (e.clientX - r.left) + 'px';
    els.brushCursor.style.top = (e.clientY - r.top) + 'px';
    els.brushCursor.classList.remove('hidden');
    if (isBrushing) paint(e);
  }
});

els.compare.addEventListener('pointerleave', () => {
  els.brushCursor.classList.add('hidden');
});

els.compare.addEventListener('pointerup', () => {
  dragging = false;
  if (isBrushing) {
    isBrushing = false;
    if (selected?.result) {
      selected.thumb.src = resizeHQ(selected.result, ...fit(selected.W, selected.H, 120)).toDataURL();
    }
  }
});

els.undoBtn.addEventListener('click', () => {
  if (!selected?.undoStack?.length) return;
  const prev = selected.undoStack.pop();
  const ctx = selected.result.getContext('2d');
  ctx.clearRect(0, 0, selected.W, selected.H);
  ctx.drawImage(prev, 0, 0);
  els.undoBtn.disabled = selected.undoStack.length === 0;
  selected.thumb.src = resizeHQ(selected.result, ...fit(selected.W, selected.H, 120)).toDataURL();
});

els.resetBrushBtn.addEventListener('click', () => {
  if (!selected?.aiSnapshot) return;
  saveUndo();
  const ctx = selected.result.getContext('2d');
  ctx.clearRect(0, 0, selected.W, selected.H);
  ctx.drawImage(selected.aiSnapshot, 0, 0);
  selected.thumb.src = resizeHQ(selected.result, ...fit(selected.W, selected.H, 120)).toDataURL();
});

// ---------------------------------------------------------------- TINH CHỈNH THỜI GIAN THỰC (60FPS)
let refineTimer, refining = false, refineAgain = false;

function onParamsChange() {
  els.threshVal.textContent = els.thresh.value + '%';
  els.trimVal.textContent = els.trim.value + 'px';
  els.radiusVal.textContent = els.radius.value;
  els.lowVal.textContent = els.low.value + '%';
  els.highVal.textContent = els.high.value + '%';
  els.radius.disabled = !els.refine.checked;

  items.forEach((i) => { if (i.status === 'done') i.dirty = true; });
  clearTimeout(refineTimer);
  refineTimer = setTimeout(refineSelected, 80);
}

async function refineSelected() {
  if (refining) { refineAgain = true; return; }
  const it = selected;
  if (!it || it.status !== 'done') return;
  refining = true;
  try {
    await refineItem(it);
    renderViewer();
  } finally {
    refining = false;
  }
  if (refineAgain) {
    refineAgain = false;
    refineSelected();
  }
}

['input', 'change'].forEach((ev) => {
  [els.thresh, els.trim, els.radius, els.low, els.high, els.refine, els.deshadow, els.keepMain].filter(Boolean).forEach((el) => {
    el.addEventListener(ev, onParamsChange);
  });
});

els.autoRbg?.addEventListener('click', () => {
  els.trim.value = 0;
  els.thresh.value = 50;
  els.radius.value = 4;
  els.low.value = 8;
  els.high.value = 95;
  if (els.keepMain) els.keepMain.checked = true;
  if (els.deshadow) els.deshadow.checked = true;
  if (els.refine) els.refine.checked = true;
  onParamsChange();
});

els.stripSticker?.addEventListener('click', () => {
  els.trim.value = 3;
  els.thresh.value = 52;
  onParamsChange();
});

els.resetBorder?.addEventListener('click', () => {
  els.trim.value = 0;
  els.thresh.value = 50;
  els.radius.value = 4;
  els.low.value = 8;
  els.high.value = 95;
  if (els.keepMain) els.keepMain.checked = true;
  if (els.deshadow) els.deshadow.checked = true;
  if (els.refine) els.refine.checked = true;
  onParamsChange();
});

// Tự động chạy lại AI khi người dùng chọn mô hình khác trong dropdown
els.model.addEventListener('change', async () => {
  const it = selected;
  if (!it?.orig) return;
  try {
    await runAI(it);
    setStatus(it, 'refine');
    await refineItem(it);
    setStatus(it, 'done');
  } catch (e) {
    it.error = e.message;
    setStatus(it, 'error');
  }
  renderViewer();
});

els.rerun.addEventListener('click', async () => {
  const it = selected;
  if (!it?.orig) return;
  try {
    await runAI(it);
    setStatus(it, 'refine');
    await refineItem(it);
    setStatus(it, 'done');
  } catch (e) {
    it.error = e.message;
    setStatus(it, 'error');
  }
  renderViewer();
});

// ---------------------------------------------------------------- NỀN & XUẤT FILE
function setBackground(bg) {
  background = bg;
  els.afterWrap.classList.toggle('checker', bg === 'transparent');
  els.afterWrap.style.backgroundColor = bg === 'transparent' ? '' : bg;
}
els.bgOptions.addEventListener('click', (e) => {
  const chip = e.target.closest('.bg-chip');
  if (!chip) return;
  els.bgOptions.querySelectorAll('.bg-chip').forEach((c) => c.classList.toggle('active', c === chip));
  setBackground(chip.dataset.bg || els.bgColor.value);
});
els.bgColor.addEventListener('input', () => {
  els.bgOptions.querySelectorAll('.bg-chip').forEach((c) => c.classList.toggle('active', c.classList.contains('custom')));
  setBackground(els.bgColor.value);
});

async function exportBlob(item) {
  if (item.dirty) await refineItem(item);
  const type = els.format.value;
  let src = item.result;
  const bg = background === 'transparent' && type === 'image/jpeg' ? '#ffffff' : background;

  if (bg !== 'transparent') {
    const flat = makeCanvas(item.W, item.H);
    const fctx = flat.getContext('2d');
    fctx.fillStyle = bg;
    fctx.fillRect(0, 0, item.W, item.H);
    fctx.drawImage(item.result, 0, 0);
    src = flat;
  }
  return new Promise((resolve) => src.toBlob(resolve, type, 0.95));
}

async function downloadItem(it) {
  if (it.status !== 'done') return;
  const blob = await exportBlob(it);
  const ext = els.format.value === 'image/jpeg' ? 'jpg' : els.format.value === 'image/webp' ? 'webp' : 'png';
  const name = it.name.replace(/\.[^.]+$/, '') + '-uycut.' + ext;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

els.download.addEventListener('click', () => { if (selected) downloadItem(selected); });
els.downloadAll.addEventListener('click', async () => {
  for (const it of items) if (it.status === 'done') await downloadItem(it);
});
els.clear.addEventListener('click', () => {
  while (items.length) removeItem(items[0]);
});

// ---------------------------------------------------------------- KÉO THẢ & DÁN FILE
['dragenter', 'dragover'].forEach((ev) => {
  document.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('drag'); });
});
['dragleave', 'drop'].forEach((ev) => {
  document.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('drag'); });
});
document.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  if (dt?.files?.length) addFiles(dt.files);
});
els.input.addEventListener('change', () => {
  if (els.input.files?.length) addFiles(els.input.files);
  els.input.value = '';
});
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = [];
  for (const it of cd.items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) files.push(new File([f], `dan-${Date.now()}.${f.type.split('/')[1] || 'png'}`, { type: f.type }));
    }
  }
  if (files.length) addFiles(files);
});
