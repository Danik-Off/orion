// Текст из файла — чтобы Орион мог прочитать его вслух, пересказать или ответить на вопрос по нему.
// Без внешних библиотек: txt/md/csv/log/json/srt — как есть (UTF-8 или Windows-1251), docx/odt/pptx/xlsx/epub —
// это zip-архивы с XML внутри, fb2 — XML, rtf — текст среди управляющих слов. PDF не читаем: в нём текст часто
// сжат и закодирован шрифтами — надёжно его без библиотеки не достать.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_BYTES = 20 * 1024 * 1024; // больше — не документ для чтения вслух
const PLAIN = /\.(txt|md|markdown|csv|tsv|log|json|srt|ini|cfg|yaml|yml|xml|html?)$/i;
const READABLE = /\.(txt|md|markdown|csv|tsv|log|json|srt|ini|cfg|yaml|yml|xml|html?|docx|odt|pptx|xlsx|epub|fb2|rtf)$/i;

// --- zip: читаем оглавление в конце архива и распаковываем нужные файлы ---
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('не zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < count && buf.readUInt32LE(p) === 0x02014b50; k++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function zipRead(buf, entry) {
  const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
  const data = buf.subarray(start, start + entry.size);
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error(`сжатие ${entry.method} не поддерживается`);
}

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

// XML → текст: концы абзацев/строк таблицы — переводы строк, остальные теги — пробелы
function xmlText(xml, paragraph = /<\/(w:p|text:p|text:h|a:p|p|h\d|li|tr|row|title|v)>/g) {
  return decodeEntities(
    xml
      .replace(/<(w:tab|text:tab)\s*\/>/g, ' ')
      .replace(/<(w:br|text:line-break|br)\s*\/?>/g, '\n')
      .replace(paragraph, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

// Кодировка: UTF-8, а если в нём «битые» символы — Windows-1251 (старые русские txt)
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8.replace(/^\uFEFF/, '');
  try {
    return new TextDecoder('windows-1251').decode(buf);
  } catch {
    return utf8;
  }
}

function rtfText(rtf) {
  return rtf
    .replace(/\\'([0-9a-f]{2})/gi, (m, h) => new TextDecoder('windows-1251').decode(Uint8Array.of(parseInt(h, 16))))
    .replace(/\\u(-?\d+)\??/g, (m, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
}

// Текст файла или { error } — понятное объяснение, почему не читается
function readText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return { error: 'PDF читать вслух пока не умею' };
  if (!READABLE.test(file)) return { error: 'это не текстовый документ' };
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES) return { error: 'файл слишком большой' };
  const buf = fs.readFileSync(file);
  let text;
  if (PLAIN.test(file)) text = decodeText(buf);
  else if (ext === '.fb2') text = xmlText(decodeText(buf).replace(/<binary[\s\S]*?<\/binary>/g, ''));
  else if (ext === '.rtf') text = rtfText(buf.toString('latin1'));
  else {
    const entries = zipEntries(buf);
    const pick = (re) => entries.filter((e) => re.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    const parts =
      ext === '.docx'
        ? pick(/^word\/document\.xml$/)
        : ext === '.odt'
          ? pick(/^content\.xml$/)
          : ext === '.pptx'
            ? pick(/^ppt\/slides\/slide\d+\.xml$/)
            : ext === '.xlsx'
              ? pick(/^xl\/sharedStrings\.xml$/)
              : pick(/\.(x?html?)$/); // epub — главы по порядку имён
    if (!parts.length) return { error: 'в документе не нашлось текста' };
    text = parts.map((e) => xmlText(zipRead(buf, e))).join('\n');
  }
  if (/\.html?$/i.test(file)) text = xmlText(text);
  text = text
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return text ? { text } : { error: 'файл пустой' };
}

module.exports = { readText, READABLE, zipEntries, zipRead };
