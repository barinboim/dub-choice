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
/**
 * Ядро ffmpeg.wasm (32 МБ) — тоже не в бандл: нужно оно только тем, кто
 * забирает пак в кодеках оригинальной игры (src/pack/tcv.ts). В проде
 * едет из R2, в деве — прямо из node_modules, если пакет установлен
 * (`npm i -D @ffmpeg/core`); без него конвертация в деве просто не
 * запустится, всё остальное работает.
 *
 * Именно `dist/esm`, а не `dist/umd`, хотя примеры ffmpeg.wasm показывают
 * второй: vite поднимает воркер модульным (`type: "module"`), а в таком
 * `importScripts` нет — воркер уходит в запасной путь с динамическим
 * `import()`, и UMD-сборка там не грузится вовсе («failed to import
 * ffmpeg-core.js»). В R2 по той же причине лежит esm-сборка.
 */
const FFMPEG_DIR = join(process.cwd(), "node_modules", "@ffmpeg", "core", "dist", "esm");

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
              : url.startsWith("/ffmpeg/")
                ? FFMPEG_DIR
                : null;
          if (!base) return next();
          const rel = decodeURIComponent(url.replace(/^\/(ort|studio-models|ffmpeg)\//, ""));
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
  // предбандлинг vite это ломает. С @ffmpeg/ffmpeg ровно то же и по той же
  // причине: он поднимает воркер через `new URL("./worker.js",
  // import.meta.url)`, а предбандленная копия в node_modules/.vite/deps
  // такого файла рядом не имеет — воркер отваливается с ERR_FAILED, и
  // `ffmpeg.load()` не падает, а молча висит вечно.
  optimizeDeps: { exclude: ["onnxruntime-web", "@ffmpeg/ffmpeg"] },
});
