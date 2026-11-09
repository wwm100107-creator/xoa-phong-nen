/**
 * main.js – ĐIỀU PHỐI TOÀN BỘ ỨNG DỤNG
 * ----------------------------------------------------------------------------
 * Luồng xử lý cho mỗi ảnh (chạy tuần tự theo hàng đợi để không tràn RAM):
 *
 *   File ──decodeImage()──► canvas gốc W×H
 *        ──predictMask()──► mặt nạ AI 1024×1024        (bước nặng, chỉ chạy 1 lần)
 *        ──refine worker──► canvas kết quả W×H có alpha (chạy lại mỗi khi chỉnh thanh trượt)
 *        ──exportBlob()───► file PNG / WebP / JPG đúng W×H
 *
 * Mặt nạ AI và ảnh "dẫn đường" (guide) được lưu lại, nên khi người dùng kéo các
 * thanh trượt tinh chỉnh, ta chỉ chạy lại bước refine (vài trăm ms) – không cần AI.
 */
import './style.css';
import { decodeImage, makeCanvas } from './decode.js';
import { predictMask, resizeHQ, AI_SIZE } from './segment.js';

const GUIDE_MAX = 1536; // cạnh dài tối đa của lưới tính hệ số Guided Filter

// ---------------------------------------------------------------- DOM
const $ = (id) => document.getElementById(id);
const els = {
  drop: $('dropzone'), input: $('fileInput'), model: $('modelSelect'),
  refine: $('refineToggle'), radius: $('radiusRange'), low: $('lowRange'), high: $('highRange'),
  radiusVal: $('radiusVal'), lowVal: $('lowVal'), highVal: $('highVal'),
  bgOptions: $('bgOptions'), bgColor: $('bgColor'), format: $('formatSelect'),
  empty: $('emptyState'), viewer: $('viewer'), meta: $('metaInfo'),
  download: $('downloadBtn'), rerun: $('rerunBtn'), compare: $('compare'),
  beforeSlot: $('beforeSlot'), afterWrap: $('afterWrap'), divider: $('divider'),
  overlay: $('overlay'), overlayText: $('overlayText'), bar: $('progressBar'),
  queue: $('queue'), queueHead: $('queueHead'), downloadAll: $('downloadAllBtn'), clear: $('clearBtn'),
};

// ---------------------------------------------------------------- TRẠNG THÁI
/** @type {Array<any>} */
const items = [];
let selected = null;
let background = 'transparent';
let seq = 0;

const STATUS = {
  queued: 'Đang chờ', decoding: 'Đang đọc ảnh', ai: 'AI đang xử lý',
  refine: 'Tinh chỉnh viền', done: 'Hoàn tất', error: 'Lỗi',
};

// ---------------------------------------------------------------- WEB WORKER
// Mỗi yêu cầu có id riêng; Promise được giải quyết khi worker trả kết quả cùng id.
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

/** Đọc giá trị các thanh trượt → tham số cho worker. */
function getParams() {
  return {
    refine: els.refine.checked,
    radius: +els.radius.value,
    low: +els.low.value / 100,
    high: +els.high.value / 100,
  };
}

// ---------------------------------------------------------------- XỬ LÝ 1 ẢNH
/**
 * Bước refine: lấy điểm ảnh gốc (W×H), gửi sang worker cùng mặt nạ & guide,
 * nhận lại cùng mảng điểm ảnh nhưng kênh alpha đã được tính → vẽ ra canvas kết quả.
 */
async function refineItem(item) {
  const { W, H } = item;
  const full = item.orig.getContext('2d').getImageData(0, 0, W, H).data;
  const res = await runWorker(
    { mask: item.mask, maskSize: AI_SIZE, guide: item.guide.data, gw: item.gw, gh: item.gh, full, W, H, params: getParams() },
    [full.buffer], // chuyển quyền sở hữu bộ nhớ (không sao chép) → nhanh, tiết kiệm RAM
  );
  if (!item.result) item.result = makeCanvas(W, H);
  item.result.getContext('2d').putImageData(new ImageData(res.full, W, H), 0, 0);
  item.refineMs = res.ms;
  item.dirty = false;
}

/** Chạy AI (tốn thời gian nhất) và lưu lại mặt nạ để tái sử dụng. */
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
    // 1) Giải mã ở độ phân giải gốc
    setStatus(item, 'decoding');
    const { canvas, width, height, format } = await decodeImage(item.file);
    Object.assign(item, { orig: canvas, W: width, H: height, format });
    item.thumb.src = resizeHQ(canvas, ...fit(width, height, 120)).toDataURL();

    // 2) Ảnh dẫn đường (guide) cho Guided Filter: bản thu nhỏ đúng tỉ lệ, cạnh dài ≤ 1536
    const [gw, gh] = fit(width, height, GUIDE_MAX);
    Object.assign(item, { gw, gh });
    item.guide = resizeHQ(canvas, gw, gh).getContext('2d').getImageData(0, 0, gw, gh);
    if (item === selected) renderViewer();

    // 3) AI → mặt nạ 1024×1024
    await runAI(item);

    // 4) Phóng mặt nạ về W×H bằng Guided Filter + ghép alpha
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

/** Hàng đợi: xử lý lần lượt từng ảnh (tránh chạy song song nhiều ảnh lớn gây tràn RAM). */
let running = false;
async function pump() {
  if (running) return;
  running = true;
  let next;
  while ((next = items.find((i) => i.status === 'queued'))) await processItem(next);
  running = false;
}

/** Thu nhỏ (w,h) cho vừa cạnh dài max, giữ tỉ lệ, không phóng to. */
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
  if (idx < 0 || ['decoding', 'ai', 'refine'].includes(item.status)) return; // không xóa khi đang xử lý
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
  renderViewer();
}

function renderViewer() {
  const it = selected;
  els.empty.classList.toggle('hidden', !!it);
  els.viewer.classList.toggle('hidden', !it);
  if (!it) return;

  // Gắn trực tiếp canvas gốc & canvas kết quả vào khung so sánh (không tạo bản sao)
  els.beforeSlot.replaceChildren(...(it.orig ? [it.orig] : []));
  els.afterWrap.replaceChildren(...(it.result ? [it.result] : []));
  els.afterWrap.style.display = it.result ? '' : 'none';

  const parts = [`<b>${escapeHtml(it.name)}</b>`];
  if (it.W) parts.push(`Gốc: ${it.W}×${it.H}px`);
  if (it.result) parts.push(`Kết quả: <span class="ok">${it.result.width}×${it.result.height}px ✓</span>`);
  if (it.aiMs) parts.push(`AI ${(it.aiMs / 1000).toFixed(1)}s · viền ${Math.round(it.refineMs)}ms`);
  if (it.status === 'error') parts.push(`<span class="err">Lỗi: ${escapeHtml(it.error)}</span>`);
  els.meta.innerHTML = parts.join(' · ');

  els.download.disabled = it.status !== 'done';
  els.rerun.disabled = !it.mask || ['decoding', 'ai', 'refine'].includes(it.status);
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

/** Thanh so sánh Trước/Sau: dùng clip-path để cắt lớp "Sau" theo vị trí chuột. */
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
els.compare.addEventListener('pointerdown', (e) => { dragging = true; els.compare.setPointerCapture(e.pointerId); moveSplit(e); });
els.compare.addEventListener('pointermove', (e) => dragging && moveSplit(e));
els.compare.addEventListener('pointerup', () => (dragging = false));
setSplit(50);

// ---------------------------------------------------------------- TINH CHỈNH (thanh trượt)
/**
 * Khi đổi thanh trượt: chỉ chạy lại bước refine cho ảnh đang xem (nhanh).
 * Các ảnh khác được đánh dấu "dirty" và sẽ áp dụng khi được chọn hoặc tải về.
 * Có debounce + cờ "busy" để không dồn hàng trăm yêu cầu khi kéo thanh trượt.
 */
let refineTimer, refining = false, refineAgain = false;
function onParamsChange() {
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
  [els.radius, els.low, els.high, els.refine].forEach((el) => el.addEventListener(ev, onParamsChange));
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

/**
 * Xuất file ĐÚNG kích thước gốc W×H.
 * - PNG/WebP + nền trong suốt: mã hóa thẳng canvas kết quả.
 * - Có màu nền hoặc JPG: tạo canvas W×H, tô màu nền, vẽ kết quả lên trên.
 */
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
    await new Promise((r) => setTimeout(r, 400)); // giãn cách để trình duyệt không chặn tải nhiều file
  }
});
els.clear.addEventListener('click', () => [...items].forEach(removeItem));

function updateBulkButtons() {
  els.downloadAll.disabled = !items.some((i) => i.status === 'done');
}

// ---------------------------------------------------------------- NHẬP ẢNH: chọn / kéo thả / dán
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
