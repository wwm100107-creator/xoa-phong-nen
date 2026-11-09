/**
 * rmbg.js – CHẠY CÁC MÔ HÌNH PHÂN ĐOẠN TRÊN TRÌNH DUYỆT
 * ----------------------------------------------------------------------------
 * Hai lựa chọn được kiểm chứng bằng ảnh thật, đừng đổi nếu chưa so lại:
 *   - Dùng bản nửa độ chính xác fp16 (88MB mỗi mô hình), cho mặt nạ như fp32 (176MB).
 *     Bản lượng tử q8 (44MB) để lọt nhiều rác nền.
 *   - Co thẳng ảnh về 1024×1024 đúng như lúc huấn luyện. Đệm viền (letterbox) làm
 *     mô hình nhận cả nền thành chủ thể.
 */
import { env, AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

// Cần cross-origin isolation (header COOP/COEP) mới chạy đa luồng được
if (globalThis.crossOriginIsolated) {
  env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
}

export const MODEL_SIZE = 1024;
const MODELS = {
  main: { id: 'briaai/RMBG-1.4', dtype: 'fp16', label: 'mô hình AI (1/2)' },
  assist: { id: 'onnx-community/ormbg-ONNX', dtype: 'fp16', label: 'mô hình AI (2/2)' },
};

const loading = new Map();

function getModel(which, onProgress) {
  if (!loading.has(which)) {
    const { id, dtype, label } = MODELS[which];
    const promise = (async () => {
      onProgress?.(`Đang tải ${label}, ~88MB, chỉ lần đầu...`, 0);
      const model = await AutoModel.from_pretrained(id, {
        dtype,
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total && p.file?.endsWith('.onnx')) {
            const ratio = p.loaded / p.total;
            onProgress?.(`Đang tải ${label}: ${Math.round(ratio * 100)}%`, ratio);
          }
        },
      });
      const processor = await AutoProcessor.from_pretrained(id);
      return { model, processor };
    })().catch((err) => {
      loading.delete(which); // cho phép thử lại nếu mạng lỗi
      throw err;
    });
    loading.set(which, promise);
  }
  return loading.get(which);
}

/**
 * Dự đoán mặt nạ cho một canvas.
 * @param which 'main' hoặc 'assist'
 * @returns {Promise<Float32Array>} MODEL_SIZE×MODEL_SIZE, giá trị 0..1
 */
export async function predictWithModel(canvas, which, onProgress) {
  const { model, processor } = await getModel(which, onProgress);

  const input = document.createElement('canvas');
  input.width = MODEL_SIZE;
  input.height = MODEL_SIZE;
  const ctx = input.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#808080'; // nền cho vùng trong suốt sẵn của ảnh PNG/WebP
  ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, MODEL_SIZE, MODEL_SIZE);

  const { data } = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
  const image = new RawImage(new Uint8ClampedArray(data), MODEL_SIZE, MODEL_SIZE, 4).rgb();
  const { pixel_values } = await processor(image);
  const inputName = model.sessions.model.inputNames[0]; // hai mô hình đặt tên đầu vào khác nhau
  const output = await model({ [inputName]: pixel_values });
  const values = output[Object.keys(output)[0]].data;

  const mask = new Float32Array(MODEL_SIZE * MODEL_SIZE);
  for (let i = 0; i < mask.length; i++) mask[i] = values[i] < 0 ? 0 : values[i] > 1 ? 1 : values[i];
  return mask;
}
