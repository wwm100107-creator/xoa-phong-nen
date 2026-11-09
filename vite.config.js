import { defineConfig } from 'vite';

// Cấu hình Vite:
// - worker.format = 'es': Web Worker (refine.worker.js) được build dạng ES module.
// - optimizeDeps.exclude: thư viện AI tự nạp file WASM/mô hình lúc chạy, không cần Vite tiền xử lý.
// - COOP/COEP: bật cross-origin isolation để WASM chạy đa luồng (nhanh hơn nhiều lần khi không có WebGPU).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@imgly/background-removal', 'onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
