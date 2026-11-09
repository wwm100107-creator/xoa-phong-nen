/**
 * decode.js – GIẢI MÃ MỌI LOẠI ẢNH VỀ ĐỘ PHÂN GIẢI GỐC
 * ----------------------------------------------------------------------------
 * Mục tiêu: dù người dùng đưa vào định dạng gì, ta đều thu được một <canvas>
 * có kích thước ĐÚNG BẰNG ảnh gốc (không thu nhỏ), chứa điểm ảnh RGBA.
 *
 * Chiến lược:
 *  1. Nhận diện định dạng bằng "magic bytes" (vài byte đầu file) + phần mở rộng,
 *     vì trên Windows file HEIC/TIFF thường có `file.type` rỗng.
 *  2. TIFF  → thư viện UTIF (trình duyệt không tự giải mã được TIFF).
 *  3. HEIC  → thử giải mã gốc (Safari hỗ trợ), thất bại thì dùng heic2any.
 *  4. SVG   → vẽ qua thẻ <img> (ảnh vector, có thể render ở kích thước lớn).
 *  5. Còn lại (JPG, PNG, WebP, AVIF, GIF, BMP, ICO, JXL…) → createImageBitmap
 *     với imageOrientation:'from-image' để tự xoay ảnh theo EXIF của điện thoại.
 */

/** Đọc vài byte đầu để đoán định dạng thật của file. */
async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  const name = file.name.toLowerCase();

  // TIFF: "II*\0" (little-endian) hoặc "MM\0*" (big-endian)
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) ||
      (head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a)) return 'tiff';

  // HEIC/HEIF/AVIF đều là container ISO-BMFF: byte 4..8 = "ftyp", sau đó là "brand"
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (/avi[fs]/.test(brand)) return 'native'; // AVIF: trình duyệt hiện đại tự giải mã
    if (/hei[cmsx]|hev[cmsx]|mif1|msf1/.test(brand)) return 'heic';
  }

  if (/^\s*(<\?xml|<svg)/i.test(ascii) || name.endsWith('.svg') || file.type === 'image/svg+xml') return 'svg';
  if (name.endsWith('.heic') || name.endsWith('.heif')) return 'heic';
  if (name.endsWith('.tif') || name.endsWith('.tiff')) return 'tiff';
  return 'native';
}

/** Tạo canvas kích thước w×h. Báo lỗi rõ ràng nếu vượt giới hạn của trình duyệt. */
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx || c.width !== w || c.height !== h) {
    throw new Error(`Ảnh ${w}×${h} vượt giới hạn canvas của trình duyệt này.`);
  }
  return c;
}

/** Vẽ một nguồn ảnh (ImageBitmap / <img>) lên canvas đúng kích thước gốc. */
function drawToCanvas(source, w, h) {
  const c = makeCanvas(w, h);
  c.getContext('2d').drawImage(source, 0, 0, w, h);
  return c;
}

/** Giải mã bằng bộ giải mã có sẵn của trình duyệt. */
async function decodeNative(blob) {
  try {
    // 'from-image' = xoay đúng chiều theo EXIF; 'none' = không trộn màu premultiply
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
    const c = drawToCanvas(bmp, bmp.width, bmp.height);
    bmp.close();
    return c;
  } catch {
    // Một số định dạng (ICO, SVG trên vài trình duyệt) chỉ giải mã được qua <img>
    return decodeViaImg(blob);
  }
}

/** Giải mã qua thẻ <img> – dùng cho SVG và làm phương án dự phòng. */
function decodeViaImg(blob, minSide = 0) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || 1024;
      let h = img.naturalHeight || 1024;
      // Ảnh vector (SVG) không có "độ phân giải" cố định → render to hơn nếu quá nhỏ
      if (minSide && Math.max(w, h) < minSide) {
        const k = minSide / Math.max(w, h);
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
      try { resolve(drawToCanvas(img, w, h)); } catch (e) { reject(e); }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Trình duyệt không đọc được định dạng ảnh này.')); };
    img.src = url;
  });
}

/** TIFF → RGBA bằng UTIF (nạp lười để không làm nặng trang ban đầu). */
async function decodeTiff(file) {
  const UTIF = (await import('utif2')).default;
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  // Chọn trang (IFD) có diện tích lớn nhất – tránh lấy nhầm ảnh thumbnail nhúng
  let best = ifds[0], area = 0;
  for (const ifd of ifds) {
    UTIF.decodeImage(buf, ifd);
    if (ifd.width * ifd.height > area) { best = ifd; area = ifd.width * ifd.height; }
  }
  const rgba = UTIF.toRGBA8(best);
  const c = makeCanvas(best.width, best.height);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), best.width, best.height), 0, 0);
  return c;
}

/** HEIC/HEIF: thử giải mã gốc trước, nếu không được thì chuyển sang PNG bằng heic2any. */
async function decodeHeic(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const c = drawToCanvas(bmp, bmp.width, bmp.height);
    bmp.close();
    return c;
  } catch {
    const heic2any = (await import('heic2any')).default;
    let out = await heic2any({ blob: file, toType: 'image/png' });
    if (Array.isArray(out)) out = out[0]; // HEIC nhiều khung (burst/live) → lấy khung đầu
    return decodeNative(out);
  }
}

/**
 * Hàm chính: File bất kỳ → { canvas, width, height, format }
 * canvas luôn có kích thước bằng ảnh gốc.
 */
export async function decodeImage(file) {
  const kind = await sniff(file);
  let canvas;
  if (kind === 'tiff') canvas = await decodeTiff(file);
  else if (kind === 'heic') canvas = await decodeHeic(file);
  else if (kind === 'svg') canvas = await decodeViaImg(file, 2048);
  else canvas = await decodeNative(file);
  return { canvas, width: canvas.width, height: canvas.height, format: kind };
}
