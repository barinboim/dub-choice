/**
 * Парсер ini-файлов в стиле Godot ConfigFile, которым пользуется The Choicer Voicer.
 *
 * Формат:
 *   [data]
 *   caption="“You will try...”"
 *   dub_timestamps=[9.796, 12.5]
 *   dub_characters=["Anakin"]
 *
 * Значения — подмножество синтаксиса Godot: строки в двойных кавычках
 * (с \" и \\ экранированием), числа, массивы строк/чисел, true/false.
 */
export type IniValue = string | number | boolean | IniValue[];
export type IniSection = Record<string, IniValue>;
export type IniFile = Record<string, IniSection>;

export function parseIni(text: string): IniFile {
  // Срезаем BOM, нормализуем переводы строк
  const src = text.replace(/^﻿/, "");
  const result: IniFile = {};
  let section: IniSection = {};
  result[""] = section;

  for (const rawLine of src.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      section = result[name] ?? {};
      result[name] = section;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue; // мусорная строка — пропускаем молча
    const key = line.slice(0, eq).trim();
    const valueText = line.slice(eq + 1).trim();
    try {
      section[key] = parseValue(valueText);
    } catch {
      // Неразборчивое значение сохраняем как сырую строку — максимальная совместимость
      section[key] = valueText;
    }
  }
  return result;
}

function parseValue(text: string): IniValue {
  const p = new ValueParser(text);
  const value = p.parse();
  p.skipWs();
  if (!p.done()) throw new Error(`Лишние символы после значения: ${text}`);
  return value;
}

class ValueParser {
  private pos = 0;
  constructor(private readonly src: string) {}

  done(): boolean {
    return this.pos >= this.src.length;
  }

  skipWs(): void {
    while (!this.done() && /\s/.test(this.src[this.pos])) this.pos++;
  }

  parse(): IniValue {
    this.skipWs();
    const ch = this.src[this.pos];
    if (ch === '"') return this.parseString();
    if (ch === "[") return this.parseArray();
    return this.parseScalar();
  }

  private parseString(): string {
    let out = "";
    this.pos++; // открывающая кавычка
    while (!this.done()) {
      const ch = this.src[this.pos];
      if (ch === "\\") {
        const next = this.src[this.pos + 1];
        if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else out += next ?? "";
        this.pos += 2;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        return out;
      }
      out += ch;
      this.pos++;
    }
    throw new Error("Незакрытая строка");
  }

  private parseArray(): IniValue[] {
    const out: IniValue[] = [];
    this.pos++; // [
    this.skipWs();
    if (this.src[this.pos] === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.parse());
      this.skipWs();
      const ch = this.src[this.pos];
      if (ch === ",") {
        this.pos++;
        continue;
      }
      if (ch === "]") {
        this.pos++;
        return out;
      }
      throw new Error("Ожидалась , или ] в массиве");
    }
  }

  private parseScalar(): IniValue {
    const start = this.pos;
    while (!this.done() && !/[,\]\s]/.test(this.src[this.pos])) this.pos++;
    const token = this.src.slice(start, this.pos);
    if (token === "true") return true;
    if (token === "false") return false;
    const num = Number(token);
    if (token !== "" && Number.isFinite(num)) return num;
    return token;
  }
}

/** Достаёт строку из секции; отсутствие/не-строка → fallback. */
export function iniString(section: IniSection | undefined, key: string, fallback = ""): string {
  const v = section?.[key];
  return typeof v === "string" ? v : fallback;
}

/** Достаёт массив строк (одиночная строка тоже принимается). */
export function iniStringArray(section: IniSection | undefined, key: string): string[] {
  const v = section?.[key];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Достаёт массив чисел (одиночное число тоже принимается). */
export function iniNumberArray(section: IniSection | undefined, key: string): number[] {
  const v = section?.[key];
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) return v.filter((x): x is number => typeof x === "number");
  return [];
}

/**
 * Обратная операция к parseIni: секции → текст в том же синтаксисе Godot
 * ConfigFile. Нужна веб-студии, чтобы писать _pack_info.ini и NN_name.ini
 * для собранного пака — игра сама ничего не сериализует, только читает.
 */
export function serializeIni(file: IniFile): string {
  const lines: string[] = [];
  // "" — секция без заголовка (студия её не использует, но парсер её
  // допускает) — пишем последней, чтобы поименованные секции шли первыми.
  const names = Object.keys(file).filter((n) => n !== "").sort();
  if (file[""] && Object.keys(file[""]).length > 0) names.push("");
  for (const name of names) {
    if (name !== "") lines.push(`[${name}]`);
    for (const [key, value] of Object.entries(file[name])) {
      lines.push(`${key}=${serializeValue(value)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function serializeValue(value: IniValue): string {
  if (typeof value === "string") return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return `[${value.map(serializeValue).join(", ")}]`;
}
