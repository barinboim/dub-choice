import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { defineConfig } from "vite";

/**
 * Второй документ студии (`studio.html`) — свой бандл, чтобы ~330 МБ весов
 * и тяжёлые библиотеки (onnxruntime-web, transformers.js) не попадали в
 * загрузку игры (docs/STUDIO_WEB_PLAN.md, «Принятые решения», п. 6).
 * COOP/COEP нигде не ставим: изоляция не даёт выигрыша (замеры фазы 0), а на
 * главной странице `COEP: require-corp` был бы регрессом галереи паков из R2
 * (у бакета нет Cross-Origin-Resource-Policy).
 */
const ORT_DIR = join(process.cwd(), "node_modules", "onnxruntime-web", "dist");
// Веса студии — не в public/: ни в git, ни в бандл. В деве отдаём с диска
// (папка studio-models/, см. .git/info/exclude), в проде — с R2, тем же
// способом, что и dub-паки.
const MODELS_DIR = join(process.cwd(), "studio-models");

const CONTENT_TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".onnx": "application/octet-stream",
  ".json": "application/json",
};

export default defineConfig({
  plugins: [
    {
      // Рантайм ort грузит свои .mjs динамическим import() — как статика в
      // public/ не отдаётся (vite примет за модуль, допишет ?import, ответит
      // 500), поэтому отдаём сами, до трансформации. Той же ручкой — веса.
      name: "studio-static",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = (req.url || "").split("?")[0];
          const base = url.startsWith("/ort/")
            ? ORT_DIR
            : url.startsWith("/studio-models/")
              ? MODELS_DIR
              : null;
          if (!base) return next();
          const rel = decodeURIComponent(url.replace(/^\/(ort|studio-models)\//, ""));
          const full = join(base, rel);
          if (!full.startsWith(base) || !existsSync(full)) return next();
          try {
            res.setHeader("Content-Type", CONTENT_TYPES[extname(full)] ?? "application/octet-stream");
            res.end(readFileSync(full));
          } catch {
            next();
          }
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: join(process.cwd(), "index.html"),
        studio: join(process.cwd(), "studio.html"),
      },
    },
  },
  // onnxruntime-web сам грузит свои воркеры/wasm по относительным путям —
  // предбандлинг vite это ломает.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
