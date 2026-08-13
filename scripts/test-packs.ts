// Прогоняет парсер по реальным пакам из соседней папки (node, без браузера)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parsePack } from "../src/pack/parser";
import { PackError, PackFileMap } from "../src/pack/types";

const packsRoot = process.argv[2] ?? join(process.cwd(), "..", "custom dub packs for voicer choicer");

let failures = 0;
for (const dir of readdirSync(packsRoot)) {
  const full = join(packsRoot, dir);
  if (!statSync(full).isDirectory()) continue;
  // Собираем файлы рекурсивно в плоскую карту — как это делает загрузчик ZIP
  const files: PackFileMap = new Map();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!files.has(name)) files.set(name, new Blob([readFileSync(p)]));
    }
  };
  walk(full);
  try {
    const pack = await parsePack(files);
    console.log(
      `✅ ${dir}: «${pack.title}» — ${pack.clips.length} реплик, ` +
        `backing=${!!pack.backingTrack}, icon=${!!pack.icon}` +
        (pack.translations.length
          ? `, переводы: ${pack.translations.join(",")} (${pack.clips.filter((c) => Object.keys(c.captions).length > 0).length} реплик)`
          : "") +
        (pack.warnings.length ? `, предупреждения: ${pack.warnings.join("; ")}` : "")
    );
    for (const clip of pack.clips.slice(0, 3)) {
      console.log(`   · ${clip.baseName} @${clip.timestamps.join(",")} [${clip.characters}] «${clip.caption.slice(0, 50)}»`);
    }
  } catch (err) {
    if (err instanceof PackError) {
      console.log(`⚠️  ${dir}: отклонён — ${err.message}`);
    } else {
      failures++;
      console.error(`❌ ${dir}:`, err);
    }
  }
}
process.exit(failures ? 1 : 0);
