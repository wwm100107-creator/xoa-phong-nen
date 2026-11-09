/**
 * rmbg.js – Chạy mô hình SOTA BRIA RMBG-1.4 bằng Transformers.js trên trình duyệt
 * ----------------------------------------------------------------------------
 * BRIA RMBG-1.4 là mô hình thế hệ mới vượt trội hoàn toàn so với IS-Net:
 * - Nhận diện chính xác các chi tiết phức tạp: lá cây, viền sticker, tóc tơ, nhiều vật thể.
 * - Model quantized q8 chỉ ~44MB, tải nhanh và chạy trên WebGPU hoặc WASM.
 */
import { env, AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';

// Cấu hình transformers.js chạy trên trình duyệt
env.allowLocalModels = false;
env.useBrowserCache = true;

let rmbgModel = null;
let rmbgProcessor = null;
let loadingPromise = null;

async function getRMBG(onProgress) {
  if (rmbgModel && rmbgProcessor) return { model: rmbgModel, processor: rmbgProcessor };
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    onProgress?.('Đang tải mô hình RMBG-1.4 Studio (~44MB)...', 0.1);
    const model = await AutoModel.from_pretrained('briaai/RMBG-1.4', {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          const ratio = p.loaded / p.total;
          onProgress?.(`Đang tải RMBG-1.4: ${Math.round(ratio * 100)}%`, ratio);
        }
      },
    });
    const processor = await AutoProcessor.from_pretrained('briaai/RMBG-1.4');
    rmbgModel = model;
    rmbgProcessor = processor;
    return { model, processor };
  })();

  return loadingPromise;
}

/**
 * Dự đoán mặt nạ từ canvas bằng mô hình BRIA RMBG-1.4.
 * Trả về Uint8Array 1024x1024 (giá trị 0..255).
 */
export async function predictRMBG(canvas, onProgress) {
  const { model, processor } = await getRMBG(onProgress);

  onProgress?.('AI RMBG-1.4 đang tách nền...', 0.9);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const url = URL.createObjectURL(blob);
  try {
    const img = await RawImage.fromURL(url);
    const { pixel_values } = await processor(img);
    const output = await model({ input: pixel_values });
    const tensor = output[Object.keys(output)[0]];
    const data = tensor.data;

    // Output là tensor 1x1x1024x1024
    const mask = new Uint8Array(1024 * 1024);
    for (let i = 0; i < mask.length; i++) {
      let v = data[i];
      if (v < 0) v = 0;
      else if (v > 1) v = 1;
      mask[i] = Math.round(v * 255);
    }
    return mask;
  } finally {
    URL.revokeObjectURL(url);
  }
}
