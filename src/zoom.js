/**
 * zoom.js – PHÓNG TO VÀ DI CHUYỂN ẢNH TRONG KHUNG XEM
 * ----------------------------------------------------------------------------
 * Chỉ dùng CSS transform trên lớp ảnh nên bố cục trang không đổi và canvas gốc không
 * bị vẽ lại. Tọa độ cọ tính bằng getBoundingClientRect đã bao gồm transform, nhờ vậy
 * vẽ vẫn trúng đúng điểm ảnh ở mọi mức phóng.
 */
const MIN_SCALE = 1;
const PIXEL_VIEW_RATIO = 2.5; // từ mức này trở lên, hiện từng điểm ảnh thay vì làm mịn

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {object} options
 * @param {HTMLElement} options.stage    khung nhìn cố định, cắt phần ảnh tràn ra ngoài
 * @param {HTMLElement} options.target   lớp ảnh được phóng
 * @param {() => number} options.getSourceWidth  chiều rộng thật của ảnh
 * @param {(scale: number) => void} options.onChange
 */
export function createZoom({ stage, target, getSourceWidth, onChange }) {
  let scale = 1, tx = 0, ty = 0;

  /** Đủ để một điểm ảnh gốc to khoảng 16px, nhưng ảnh nhỏ vẫn phóng được ít nhất 8 lần. */
  const maxScale = () => clamp(16 * getSourceWidth() / Math.max(1, target.offsetWidth), 8, 64);

  /**
   * Cho kéo tới khi mép ảnh chạm giữa khung. Không ép ảnh phủ kín khung, vì như vậy
   * điểm dưới con trỏ sẽ bị trôi khi phóng và khó đưa vùng sát mép ảnh vào giữa.
   */
  const fitAxis = (offset, viewSize, size, translate) =>
    clamp(translate, viewSize / 2 - size * scale - offset, viewSize / 2 - offset);

  const apply = () => {
    if (scale === 1) { tx = 0; ty = 0; } else {
      tx = fitAxis(target.offsetLeft, stage.clientWidth, target.offsetWidth, tx);
      ty = fitAxis(target.offsetTop, stage.clientHeight, target.offsetHeight, ty);
    }
    target.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    const screenPerSource = scale * target.offsetWidth / Math.max(1, getSourceWidth());
    target.classList.toggle('pixel-view', screenPerSource >= PIXEL_VIEW_RATIO);
    onChange(scale);
  };

  /** Phóng quanh một điểm trên màn hình, điểm ảnh dưới con trỏ đứng yên. */
  const zoomAt = (clientX, clientY, factor) => {
    const next = clamp(scale * factor, MIN_SCALE, maxScale());
    if (next === scale) return;
    // Đo vị trí thật trên màn hình; offsetLeft bị làm tròn nên sẽ gây trôi khi phóng lớn
    const rect = target.getBoundingClientRect();
    const k = 1 - next / scale;
    tx += (clientX - rect.left) * k;
    ty += (clientY - rect.top) * k;
    scale = next;
    apply();
  };

  return {
    get scale() { return scale; },
    zoomAt,
    zoomCenter(factor) {
      const rect = stage.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    },
    panBy(dx, dy) {
      tx += dx;
      ty += dy;
      apply();
    },
    reset() {
      scale = 1;
      apply();
    },
    refresh: apply,
  };
}
