// Phase R — tiny zero-dependency PDF 1.4 writer (PRD §8 "boring tools, by
// hand"; the weekly client summary is "sent to the client portal and as a PDF").
// Emits a multi-page document of Helvetica text lines. No libraries.
//
//   pdf.fromLines(lines, { title }) -> Buffer
//   lines: string[] OR { text, gap }[] — gap is the pt advance after the line
//     (default 14). Overfull lines roll onto the next page automatically.

const W = 612, H = 792; // US Letter in points
const MARGIN = 48;
const LH = 14;          // default line height
const FS = 10;          // font size

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // drop non-latin1 chars into '?' (Helvetica base-14 is latin1)
    .replace(/[^\x00-\xFF]/g, '?');
}

function normalize(input, title) {
  let raw = Array.isArray(input)
    ? input.map((t) => ({ text: String(t) }))
    : (input && input.lines || []).map((l) => (typeof l === 'string' ? { text: l } : l));
  if (title) raw = [{ text: title, gap: 18 }, { text: '', gap: LH }, ...raw];
  return raw;
}

// Chunk lines into pages by cumulative gap so no page overflows.
function paginate(lines) {
  const usable = H - 2 * MARGIN;
  const pages = [];
  let cur = [], used = 0;
  for (const ln of lines) {
    const gap = ln.gap || LH;
    if (used + gap > usable && cur.length) { pages.push(cur); cur = []; used = 0; }
    cur.push(ln); used += gap;
  }
  if (cur.length) pages.push(cur);
  return pages.length ? pages : [[{ text: 'No data yet.' }]];
}

function contentStream(pageLines) {
  let y = H - MARGIN;
  const parts = [`BT /F1 ${FS} Tf`];
  for (const ln of pageLines) {
    parts.push(`${MARGIN} ${y} Td (${esc(ln.text)}) Tj`);
    y -= (ln.gap || LH);
  }
  parts.push('ET');
  return parts.join('\n');
}

function fromLines(input, { title = '' } = {}) {
  const lines = normalize(input, title);
  const pages = paginate(lines);

  // Object numbering: 1 Catalog, 2 Pages, then per page (page, content),
  // and the font object at the end.
  let next = 3;
  const pagesMeta = pages.map(() => {
    const pageNum = next; next += 1;
    const contentNum = next; next += 1;
    return { pageNum, contentNum };
  });
  const fontNum = next;

  const obj = {};
  obj[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  obj[2] = `<< /Type /Pages /Kids [${pagesMeta.map((p) => `${p.pageNum} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pagesMeta.forEach((m, i) => {
    const cs = contentStream(pages[i]);
    obj[m.pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${m.contentNum} 0 R >>`;
    obj[m.contentNum] = `<< /Length ${Buffer.byteLength(cs)} >>\nstream\n${cs}\nendstream`;
  });
  obj[fontNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  let pdf = '%PDF-1.4\n';
  const maxObj = fontNum;
  const offsets = [];
  for (let i = 1; i <= maxObj; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${obj[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// convenience: heading + bullet sections -> PDF Buffer
function report({ title = '', sections = [] } = {}) {
  const lines = [];
  if (title) lines.push({ text: title, gap: 18 });
  for (const s of sections) {
    if (s.heading) lines.push({ text: s.heading, gap: 18 });
    for (const l of (s.lines || [])) lines.push({ text: l, gap: LH });
    lines.push({ text: '', gap: LH });
  }
  return fromLines(lines, {});
}

module.exports = { fromLines, report, W, H, MARGIN };
