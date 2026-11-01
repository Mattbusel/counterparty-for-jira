// Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF, and the
// trailing 0x1A end-of-file byte that OFAC still ships in its CSV exports.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\u001a') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** OFAC uses "-0-" for empty cells. */
export function ofacCell(v) {
  const s = (v || '').trim();
  return s === '-0-' ? '' : s;
}
