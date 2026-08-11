// Копирует wasm/js ассеты ogv.js в public/ogv, чтобы OGVLoader мог их подгружать
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "ogv", "dist");
const dest = join(root, "public", "ogv");

if (!existsSync(src)) {
  console.error("ogv dist не найден — сначала npm install");
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log("ogv.js ассеты скопированы в public/ogv");
