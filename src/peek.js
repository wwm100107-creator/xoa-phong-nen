/**
 * peek.js – PHÍM GIỮ ĐỂ XEM ẢNH GỐC, GÁN LẠI ĐƯỢC BẰNG BÀN PHÍM HOẶC CHUỘT
 * ----------------------------------------------------------------------------
 * Module chỉ lo việc "phím đang được giữ hay không" và lưu lựa chọn của người dùng.
 * Việc hiển thị do main.js đảm nhận qua callback onHoldChange.
 *
 * Dùng mousedown/mouseup thay vì sự kiện pointer vì pointerdown không báo nút thứ hai
 * khi người dùng đang giữ sẵn một nút, ví dụ vừa kéo cọ vừa giữ chuột phải.
 */
const STORAGE_KEY = 'uycut.peekBinding';
const DEFAULT_BINDING = { kind: 'key', key: 'Control' };

const MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta'];
const MOUSE_LABELS = { 1: 'Chuột giữa', 2: 'Chuột phải', 3: 'Chuột lùi', 4: 'Chuột tiến' };
const KEY_LABELS = { Control: 'Ctrl', Meta: 'Win', Space: 'Dấu cách', Backquote: '`', Minus: '-', Equal: '=' };

/** Mã phím không phụ thuộc bộ gõ tiếng Việt; Ctrl trái và phải được coi là một. */
function keyIdOf(event) {
  return MODIFIERS.includes(event.key) ? event.key : event.code || event.key;
}

function labelOf(binding) {
  if (binding.kind === 'mouse') return MOUSE_LABELS[binding.button] || `Chuột ${binding.button + 1}`;
  const { key } = binding;
  return KEY_LABELS[key] || key.replace(/^Key|^Digit/, '').replace(/^Arrow/, 'Mũi tên ');
}

function isValid(binding) {
  if (binding?.kind === 'key') return typeof binding.key === 'string' && binding.key.length > 0;
  return binding?.kind === 'mouse' && Number.isInteger(binding.button) && binding.button > 0;
}

function loadBinding() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isValid(saved)) return saved;
  } catch { /* trình duyệt chặn lưu trữ hoặc dữ liệu hỏng: dùng mặc định */ }
  return DEFAULT_BINDING;
}

function saveBinding(binding) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(binding));
  } catch { /* vẫn dùng được trong phiên hiện tại */ }
}

/** Đang gõ trong ô nhập thì phím thuộc về ô đó; thanh trượt vẫn cho phép xem ảnh gốc. */
const isTypingTarget = (target) => target?.matches?.('input:not([type=range]), select, textarea');

/**
 * @param {object} options
 * @param {HTMLElement} options.button    nút hiển thị và đổi phím
 * @param {HTMLElement} options.stage     vùng ảnh; phím chuột chỉ có tác dụng trong vùng này
 * @param {() => boolean} options.isAvailable  công cụ hiện tại có dùng tính năng này không
 * @param {(held: boolean) => void} options.onHoldChange
 * @param {() => void} options.onBindingChange
 */
export function createPeek({ button, stage, isAvailable, onHoldChange, onBindingChange }) {
  let binding = loadBinding();
  let capturing = false;
  let held = false;
  let swallowMouseUp = null; // nút chuột vừa dùng để gán, không cho kích hoạt Back/Forward
  let swallowMenu = false;

  const render = (message) => {
    button.classList.toggle('capturing', capturing);
    button.classList.toggle('held', held);
    button.innerHTML = capturing
      ? (message || 'Nhấn phím hoặc nút chuột… <small>Esc để hủy</small>')
      : `Giữ <kbd>${labelOf(binding)}</kbd> xem ảnh gốc <small>Đổi</small>`;
  };

  const setHeld = (value) => {
    if (held === value) return;
    held = value;
    button.classList.toggle('held', held);
    onHoldChange(held);
  };

  const stopCapture = () => {
    capturing = false;
    render();
  };

  const assign = (next) => {
    binding = next;
    saveBinding(binding);
    setHeld(false);
    stopCapture();
    button.blur(); // để Enter hay dấu cách vừa gán không bấm lại vào nút này
    onBindingChange();
  };

  button.addEventListener('click', () => {
    capturing = !capturing;
    render();
  });

  window.addEventListener('keydown', (e) => {
    if (capturing) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.key === 'Escape') stopCapture();
      else assign({ kind: 'key', key: keyIdOf(e) });
      return;
    }
    if (binding.kind !== 'key' || keyIdOf(e) !== binding.key) return;
    if (!isAvailable() || isTypingTarget(e.target)) return;
    if (e.key !== 'Control' && e.key !== 'Shift' && e.key !== 'Meta') e.preventDefault(); // dấu cách cuộn trang, Alt mở menu
    setHeld(true);
  }, true);

  window.addEventListener('keyup', (e) => {
    if (binding.kind !== 'key' || keyIdOf(e) !== binding.key || !held) return;
    if (e.key === 'Alt') e.preventDefault();
    setHeld(false);
  }, true);

  window.addEventListener('mousedown', (e) => {
    if (capturing) {
      if (e.button === 0) {
        if (!button.contains(e.target)) render('Chuột trái dùng để vẽ, hãy chọn nút khác… <small>Esc để hủy</small>');
        return;
      }
      e.preventDefault();
      swallowMouseUp = e.button;
      swallowMenu = e.button === 2;
      assign({ kind: 'mouse', button: e.button });
      return;
    }
    if (binding.kind !== 'mouse' || e.button !== binding.button) return;
    if (!stage.contains(e.target) || !isAvailable()) return;
    e.preventDefault(); // chuột giữa tự cuộn trang
    setHeld(true);
  }, true);

  window.addEventListener('mouseup', (e) => {
    if (e.button === swallowMouseUp) {
      e.preventDefault();
      swallowMouseUp = null;
      return;
    }
    if (binding.kind !== 'mouse' || e.button !== binding.button || !held) return;
    e.preventDefault(); // nút lùi/tiến của chuột không được chuyển trang
    setHeld(false);
  }, true);

  window.addEventListener('contextmenu', (e) => {
    const onStage = binding.kind === 'mouse' && binding.button === 2 && stage.contains(e.target) && isAvailable();
    if (capturing || swallowMenu || onStage) e.preventDefault();
    swallowMenu = false;
  }, true);

  window.addEventListener('auxclick', (e) => {
    if (binding.kind === 'mouse' && e.button === binding.button && stage.contains(e.target) && isAvailable()) e.preventDefault();
  }, true);

  // Rời cửa sổ khi đang giữ phím thì sẽ không nhận được keyup
  const release = () => setHeld(false);
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  render();
  return {
    get held() { return held; },
    get label() { return labelOf(binding); },
  };
}
