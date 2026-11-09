/**
 * main.js – ĐIỀU PHỐI TOÀN BỘ ỨNG DỤNG UYCUT AI
 * ----------------------------------------------------------------------------
 * Luồng xử lý cho mỗi ảnh:
 *   File ──decodeImage()──► canvas gốc W×H
 *        ──predictMask()──► mặt nạ AI (RMBG-1.4 hoặc IS-Net)
 *        ──refine worker──► canvas kết quả W×H có alpha chuẩn (Uncertainty Band)
 *        ──Touch-up Brush─► Khôi phục / Xóa chi tiết thủ công ngay tức thì
 *        ──exportBlob()───► file PNG / WebP / JPG đúng W×H
 */
import './style.css';
import { decodeImage, makeCanvas } from './decode.js';
import { predictMask, resizeHQ, AI_SIZE } from './segment.js';

const GUIDE_MAX = 1536;

// ---------------------------------------------------------------- DOM
const $ = (id) => document.getElementById(id);
const els = {
  drop: $('dropzone'), input: $('fileInput'), model: $('modelSelect'),
  refine: $('refineToggle'), radius: $('radiusRange'), low: $('lowRange'), high: $('highRange'),
  thresh: $('threshRange'), threshVal: $('threshVal'),
  radiusVal: $('radiusVal'), lowVal: $('lowVal'), highVal: $('highVal'),
  bgOptions: $('bgOptions'), bgColor: $('bgColor'), format: $('formatSelect'),
  empty: $('emptyState'), viewer: $('viewer'), meta: $('metaInfo'),
  download: $('downloadBtn'), rerun: $('rerunBtn'), compare: $('compare'),
  beforeSlot: $('beforeSlot'), afterWrap: $('afterWrap'), divider: $('divider'),
  overlay: $('overlay'), overlayText: $('overlayText'), bar: $('progressBar'),
  queue: $('queue'), queueHead: $('queueHead'), downloadAll: $('downloadAllBtn'), clear: $('clearBtn'),
  // Bộ công cụ Cọ chỉnh sửa thủ công
  modeCompare: $('modeCompareBtn'), modeRestore: $('modeRestoreBtn'), modeErase: $('modeEraseBtn'),
  brushParams: $('brushParams'), brushSize: $('brushSizeRange'), brushSizeVal: $('brushSizeVal'),
  undoBtn: $('undoBtn'), resetBrushBtn: $('resetBrushBtn'), brushCursor: $('brushCursor'),
};

// ---------------------------------------------------------------- TRẠNG THÁI
/** @type {Array<any>} */
const items = [];
let selected = null;
let background = 'transparent';
let seq = 0;
let currentTool = 'compare'; // 'compare' | 'restore' | 'erase'
let isBrushing = false;

const STATUS = {
  queued: 'Đang chờ', decoding: 'Đang đọc ảnh', ai: 'AI đang xử lý',
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
  const delta = (0.5 - t) * 0.35; // Khi t cao (muốn lấy nhiều viền/lá): delta âm -> low và high giảm
  const lowOffset = +els.low.value / 100;
  const highOffset = +els.high.value / 100;
  const low = Math.max(0, Math.min(0.45, lowOffset + delta));
  const high = Math.max(0.55, Math.min(1, highOffset + delta));

  return {
    refine: els.refine.checked,
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

  // Lưu bản snapshot AI ban đầu để có thể Reset khi dùng Cọ
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
    const item = { id: ++seq, file, name: file.name || `anh-dan-${seq}.png`, status: 'queued' };
    item.li = buildQueueRow(item);
    items.push(item);
  }
  if (!selected) select(items[items.length - files.length]);
  els.queueHead.classList.remove('hidden');
  pump();
}

function buildQueueRow(item) {
  const li = document.createElement('li');
  li.className = 'q-item';
  li.innerHTML = `
    <div class="q-thumb checker"><img alt=""></div>
    <div class="q-info"><b></b><small></small></div>
    <span class="q-badge"></span>
    <button class="q-dl" title="Tải ảnh này" disabled>⬇</button>
    <button class="q-rm" title="Xóa">✕</button>`;
  item.thumb = li.querySelector('img');
  li.querySelector('b').textContent = item.name;
  li.querySelector('small').textContent = `${(item.file.size / 1048576).toFixed(2)} MB`;
  li.addEventListener('click', () => select(item));
  li.querySelector('.q-dl').addEventListener('click', (e) => { e.stopPropagation(); download(item); });
  li.querySelector('.q-rm').addEventListener('click', (e) => { e.stopPropagation(); removeItem(item); });
  els.queue.appendChild(li);
  item.li = li;
  setStatus(item, 'queued');
  return li;
}

function setStatus(item, status) {
  item.status = status;
  const li = item.li || null;
  if (li) {
    const badge = li.querySelector('.q-badge');
    badge.textContent = status === 'error' ? 'Lỗi' : STATUS[status];
    badge.dataset.s = status;
    badge.title = item.error || '';
    li.querySelector('.q-dl').disabled = status !== 'done';
  }
  if (item === selected) {
    if (['decoding', 'ai', 'refine'].includes(status)) showOverlay(STATUS[status] + '…', status === 'refine' ? 1 : null);
    else hideOverlay();
  }
}

function removeItem(item) {
  const idx = items.indexOf(item);
  if (idx < 0 || ['decoding', 'ai', 'refine'].includes(item.status)) return;
  items.splice(idx, 1);
  item.li.remove();
  if (selected === item) { selected = null; select(items[Math.min(idx, items.length - 1)]); }
  if (!items.length) { els.queueHead.classList.add('hidden'); renderViewer(); }
  updateBulkButtons();
}

// ---------------------------------------------------------------- XEM TRƯỚC
async function select(item) {
  selected = item || null;
  items.forEach((i) => i.li.classList.toggle('active', i === selected));
  if (selected?.status === 'done' && selected.dirty) {
    showOverlay('Áp dụng tinh chỉnh…', 1);
    await refineItem(selected);
    hideOverlay();
  }
  setTool(currentTool);
  renderViewer();
}

function renderViewer() {
  const it = selected;
  els.empty.classList.toggle('hidden', !!it);
  els.viewer.classList.toggle('hidden', !it);
  if (!it) return;

  els.beforeSlot.replaceChildren(...(it.orig ? [it.orig] : []));
  els.afterWrap.replaceChildren(...(it.result ? [it.result] : []));
  els.afterWrap.style.display = it.result ? '' : 'none';

  const parts = [`<b>${escapeHtml(it.name)}</b>`];
  if (it.W) parts.push(`Gốc: ${it.W}×${it.H}px`);
  if (it.result) parts.push(`Kết quả: <span class="ok">${it.result.width}×${it.result.height}px ✓</span>`);
  if (it.model) parts.push(`Mô hình: ${it.model}`);
  if (it.aiMs) parts.push(`AI ${(it.aiMs / 1000).toFixed(1)}s · viền ${Math.round(it.refineMs)}ms`);
  if (it.status === 'error') parts.push(`<span class="err">Lỗi: ${escapeHtml(it.error)}</span>`);
  els.meta.innerHTML = parts.join(' · ');

  els.download.disabled = it.status !== 'done';
  els.rerun.disabled = !it.mask || ['decoding', 'ai', 'refine'].includes(it.status);
  els.undoBtn.disabled = !(it.undoStack && it.undoStack.length > 0);

  if (['decoding', 'ai', 'refine'].includes(it.status)) showOverlay(STATUS[it.status] + '…', null);
  else if (it.status === 'queued') showOverlay('Đang chờ tới lượt…', null);
  else hideOverlay();
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

// ---------------------------------------------------------------- BỘ CÔNG CỤ CỌ (TOUCH-UP)
function setTool(tool) {
  currentTool = tool;
  els.modeCompare.classList.toggle('active', tool === 'compare');
  els.modeRestore.classList.toggle('active', tool === 'restore');
  els.modeErase.classList.toggle('active', tool === 'erase');

  if (tool === 'compare') {
    els.compare.classList.remove('brush-mode');
    els.brushParams.classList.add('hidden');
    els.brushCursor.classList.add('hidden');
    setSplit(50);
  } else {
    els.compare.classList.add('brush-mode');
    els.brushParams.classList.remove('hidden');
    els.afterWrap.style.clipPath = 'none'; // hiển thị trọn vẹn kết quả để chỉnh sửa
    updateBrushCursorSize();
  }
}

function updateBrushCursorSize() {
  const size = +els.brushSize.value;
  els.brushSizeVal.textContent = size + 'px';
  els.brushCursor.style.width = size + 'px';
  els.brushCursor.style.height = size + 'px';
}

els.modeCompare.addEventListener('click', () => setTool('compare'));
els.modeRestore.addEventListener('click', () => setTool('restore'));
els.modeErase.addEventListener('click', () => setTool('erase'));
els.brushSize.addEventListener('input', updateBrushCursorSize);

// Thao tác vẽ trên Stage (Compare hoặc Cọ)
function getCanvasCoords(e) {
  const canvas = els.beforeSlot.querySelector('canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const scaleX = selected.W / rect.width;
  const scaleY = selected.H / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  const radius = (+els.brushSize.value / 2) * Math.max(scaleX, scaleY);
  return { x, y, radius };
}

function paint(e) {
  if (!selected?.result || !selected?.orig) return;
  const coords = getCanvasCoords(e);
  if (!coords) return;
  const { x, y, radius } = coords;
  const ctx = selected.result.getContext('2d');

  if (currentTool === 'restore') {
    // Khôi phục chi tiết ảnh gốc
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(selected.orig, 0, 0);
    ctx.restore();
  } else if (currentTool === 'erase') {
    // Xóa thành trong suốt
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
  } else if (selected?.result) {
    isBrushing = true;
    els.compare.setPointerCapture(e.pointerId);

    // Lưu snapshot vào undo stack
    if (!selected.undoStack) selected.undoStack = [];
    if (selected.undoStack.length >= 15) selected.undoStack.shift();
    const snap = makeCanvas(selected.W, selected.H);
    snap.getContext('2d').drawImage(selected.result, 0, 0);
    selected.undoStack.push(snap);
    els.undoBtn.disabled = false;

    paint(e);
  }
});

els.compare.addEventListener('pointermove', (e) => {
  if (currentTool === 'compare') {
    if (dragging) moveSplit(e);
  } else {
    // Cập nhật con trỏ tròn
    const r = els.compare.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    els.brushCursor.style.left = cx + 'px';
    els.brushCursor.style.top = cy + 'px';
    els.brushCursor.classList.remove('hidden');

    if (isBrushing) paint(e);
  }
});

els.compare.addEventListener('pointerleave', () => {
  if (currentTool !== 'compare') els.brushCursor.classList.add('hidden');
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
  // Lưu trạng thái hiện tại vào undo trước khi reset
  const snap = makeCanvas(selected.W, selected.H);
  snap.getContext('2d').drawImage(selected.result, 0, 0);
  selected.undoStack.push(snap);
  els.undoBtn.disabled = false;

  const ctx = selected.result.getContext('2d');
  ctx.clearRect(0, 0, selected.W, selected.H);
  ctx.drawImage(selected.aiSnapshot, 0, 0);
  selected.thumb.src = resizeHQ(selected.result, ...fit(selected.W, selected.H, 120)).toDataURL();
});

// ---------------------------------------------------------------- TINH CHỈNH (thanh trượt)
let refineTimer, refining = false, refineAgain = false;
function onParamsChange() {
  els.threshVal.textContent = els.thresh.value + '%';
  els.radiusVal.textContent = els.radius.value;
  els.lowVal.textContent = els.low.value + '%';
  els.highVal.textContent = els.high.value + '%';
  els.radius.disabled = !els.refine.checked;
  items.forEach((i) => { if (i.status === 'done') i.dirty = true; });
  clearTimeout(refineTimer);
  refineTimer = setTimeout(refineSelected, 120);
}
async function refineSelected() {
  if (refining) { refineAgain = true; return; }
  const it = selected;
  if (!it || it.status !== 'done') return;
  refining = true;
  try { await refineItem(it); renderViewer(); } finally { refining = false; }
  if (refineAgain) { refineAgain = false; refineSelected(); }
}
['input', 'change'].forEach((ev) => {
  [els.thresh, els.radius, els.low, els.high, els.refine].forEach((el) => el.addEventListener(ev, onParamsChange));
});

els.rerun.addEventListener('click', async () => {
  const it = selected;
  if (!it?.orig) return;
  try {
    await runAI(it);
    setStatus(it, 'refine');
    await refineItem(it);
    setStatus(it, 'done');
  } catch (e) { it.error = e.message; setStatus(it, 'error'); }
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
    src = makeCanvas(item.W, item.H);
    const ctx = src.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, item.W, item.H);
    ctx.drawImage(item.result, 0, 0);
  }
  const quality = type === 'image/jpeg' ? 0.95 : 1;
  const blob = await new Promise((r) => src.toBlob(r, type, quality));
  if (!blob) throw new Error('Trình duyệt không mã hóa được ảnh (có thể quá lớn).');
  return blob;
}

async function download(item) {
  if (!item || item.status !== 'done') return;
  const blob = await exportBlob(item);
  const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[blob.type] || 'png';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `uycut-${item.name.replace(/\.[^.]+$/, '')}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

els.download.addEventListener('click', () => download(selected));
els.downloadAll.addEventListener('click', async () => {
  for (const it of items.filter((i) => i.status === 'done')) {
    await download(it);
    await new Promise((r) => setTimeout(r, 400));
  }
});
els.clear.addEventListener('click', () => [...items].forEach(removeItem));

function updateBulkButtons() {
  els.downloadAll.disabled = !items.some((i) => i.status === 'done');
}

// ---------------------------------------------------------------- NHẬP ẢNH
els.input.addEventListener('change', () => { addFiles(els.input.files); els.input.value = ''; });
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) els.drop.classList.remove('drag'); }));
document.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
document.addEventListener('paste', (e) => addFiles(e.clipboardData?.files || []));
els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') els.input.click(); });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

onParamsChange();
