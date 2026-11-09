import { defineConfig } from 'vite';

// Cấu hình Vite:
// - worker.format = 'es': Web Worker (refine.worker.js) được build dạng ES module.
// - optimizeDeps.exclude: thư viện AI tự nạp file WASM/mô hình lúc chạy, không cần Vite tiền xử lý.
export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@imgly/background-removal', 'onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
