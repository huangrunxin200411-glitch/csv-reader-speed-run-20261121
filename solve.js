// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
// Same answers as the reference, faster: indexOf/slice fast paths instead of
// one-character-at-a-time string building. Pure, no state kept between calls.
//
// Semantics (from the reference): BOM dropped; records end at LF/CRLF, empty
// lines are no record; lone CR outside quotes is dropped (stray_cr); a field
// opening with a quote runs to the next non-doubled quote, "" inside is one
// quote, CRLF/lone CR inside is LF; text after the closing quote up to the
// next comma/line break is appended as-is (quote_junk); a quote that never
// closes is literal and the rest is re-read unquoted (unterminated_quote);
// a quote inside an unquoted field is literal; fields stay strings; rows
// are padded (short_row) or cut (long_row) to the first record's width;
// errors are {code, line, row} in the order met, line = 1-based line the
// record starts on, row = its index in rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Normalize CR/LF inside a quoted segment to LF, counting lines.
  // Returns the normalized segment; fast path when it holds neither.
  function norm(s) {
    if (s.indexOf('\r') === -1 && s.indexOf('\n') === -1) return s;
    let out = '';
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const cc = s.charCodeAt(i);
      if (cc === 13) {
        out += s.slice(start, i) + '\n';
        line++;
        if (i + 1 < s.length && s.charCodeAt(i + 1) === 10) i++;
        start = i + 1;
      } else if (cc === 10) {
        out += s.slice(start, i) + '\n';
        line++;
        start = i + 1;
      }
    }
    return out + s.slice(start);
  }

  // Read an unquoted field starting at pos, with `init` as its starting
  // value. Returns [value, ended, added] where added counts kept chars.
  // One native regex scan per field instead of three indexOf scans.
  const DELIM = /[,\n\r]/g;
  function readUnquoted(init) {
    let v = init;
    let added = 0;
    while (pos < n) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        v += text.slice(pos); added += n - pos; pos = n;
        return [v, END, added];
      }
      const idx = m.index;
      const ch = m[0];
      if (ch === '\r') {
        if (idx + 1 < n && text.charCodeAt(idx + 1) === 10) {
          v += text.slice(pos, idx); added += idx - pos;
          pos = idx + 2; line++;
          return [v, LINE_BREAK, added];
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        v += text.slice(pos, idx); added += idx - pos;
        pos = idx + 1;
        continue;
      }
      v += text.slice(pos, idx); added += idx - pos;
      if (ch === ',') { pos = idx + 1; return [v, COMMA, added]; }
      pos = idx + 1; line++;
      return [v, LINE_BREAK, added];
    }
    return [v, END, added];
  }

  // Read a quoted field whose opening quote is at pos.
  // Returns [value, ended, added] (added is unused for quoted fields).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos++;
    let v = '';
    let segStart = pos;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        v += norm(text.slice(segStart, q)) + '"';
        pos = q + 2;
        segStart = pos;
        continue;
      }
      v += norm(text.slice(segStart, q));
      pos = q + 1;
      break;
    }
    if (pos >= n) return [v, END, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) { pos++; return [v, COMMA, 0]; }
    if (c === 10) { pos++; line++; return [v, LINE_BREAK, 0]; }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line++;
      return [v, LINE_BREAK, 0];
    }
    const junk = readUnquoted(v);
    if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    while (pos < n) {
      const cc = text.charCodeAt(pos);
      if (cc === 10) { pos++; line++; }
      else if (cc === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line++; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = (header && columns === null) ? null : rows.length;
    const fields = [];
    let ended;
    let quoted = false;
    do {
      let r;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        r = readQuoted();
      } else {
        quoted = false;
        r = readUnquoted('');
      }
      fields.push(r[0]);
      ended = r[1];
    } while (ended === COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
