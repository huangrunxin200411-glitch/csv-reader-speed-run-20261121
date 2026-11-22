// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01) — v3.
// v2 inlined: the per-field helper calls and their 3-element array returns
// are gone. The common unquoted field is one native regex scan + one slice
// inside the record loop; quoted segments skip the norm() call unless they
// actually hold CR/LF. Same answers as the reference; pure, no state kept
// between calls.
//
// Semantics (from the reference): BOM dropped; records end at LF/CRLF, empty
// lines are no record; lone CR outside quotes is dropped (stray_cr); a field
// opening with a quote runs to the next non-doubled quote, "" inside is one
// quote, CRLF/lone CR inside is LF; text after the closing quote up to the
// next comma/line-break is appended as-is (quote_junk); a quote that never
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
  // Only called when the segment actually holds CR or LF.
  function norm(s) {
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

  // Fast path for a quoted segment: no CR/LF means no normalization.
  function normSeg(s) {
    if (s.indexOf('\r') === -1 && s.indexOf('\n') === -1) return s;
    return norm(s);
  }

  // One native regex scan per unquoted field. Rare paths only (junk after a
  // closing quote, re-read after an unterminated quote); the hot unquoted
  // path is inlined in the record loop below. Writes uVal/uEnd/uAdded.
  const DELIM = /[,\n\r]/g;
  let uVal = '';
  let uEnd = END;
  let uAdded = 0;
  function readUnquoted(init) {
    let v = init;
    let added = 0;
    while (pos < n) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        v += text.slice(pos); added += n - pos; pos = n;
        uVal = v; uEnd = END; uAdded = added;
        return;
      }
      const idx = m.index;
      const ch = m[0];
      if (ch === '\r') {
        if (idx + 1 < n && text.charCodeAt(idx + 1) === 10) {
          v += text.slice(pos, idx); added += idx - pos;
          pos = idx + 2; line++;
          uVal = v; uEnd = LINE_BREAK; uAdded = added;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        v += text.slice(pos, idx); added += idx - pos;
        pos = idx + 1;
        continue;
      }
      v += text.slice(pos, idx); added += idx - pos;
      if (ch === ',') { pos = idx + 1; uVal = v; uEnd = COMMA; uAdded = added; return; }
      pos = idx + 1; line++;
      uVal = v; uEnd = LINE_BREAK; uAdded = added;
      return;
    }
    uVal = v; uEnd = END; uAdded = added;
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
      let val;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        pos++;
        let v = '';
        let segStart = pos;
        let closed = false;
        while (true) {
          const q = text.indexOf('"', pos);
          if (q === -1) {
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            break;
          }
          if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
            v += normSeg(text.slice(segStart, q)) + '"';
            pos = q + 2;
            segStart = pos;
            continue;
          }
          v += normSeg(text.slice(segStart, q));
          pos = q + 1;
          closed = true;
          break;
        }
        if (!closed) {
          readUnquoted('"');
          val = uVal; ended = uEnd;
        } else if (pos >= n) {
          val = v; ended = END;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) { pos++; val = v; ended = COMMA; }
          else if (c === 10) { pos++; line++; val = v; ended = LINE_BREAK; }
          else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
            pos += 2; line++; val = v; ended = LINE_BREAK;
          } else {
            readUnquoted(v);
            if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            val = uVal; ended = uEnd;
          }
        }
      } else {
        quoted = false;
        // Hot path: unquoted field, inlined. One regex scan per segment;
        // usually a single segment ending at a comma or line break.
        let v = '';
        while (true) {
          if (pos >= n) { ended = END; break; }
          DELIM.lastIndex = pos;
          const m = DELIM.exec(text);
          if (m === null) {
            v += text.slice(pos); pos = n; ended = END; break;
          }
          const idx = m.index;
          const ch = m[0];
          if (ch === '\r') {
            if (idx + 1 < n && text.charCodeAt(idx + 1) === 10) {
              v += text.slice(pos, idx);
              pos = idx + 2; line++; ended = LINE_BREAK; break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            v += text.slice(pos, idx);
            pos = idx + 1;
            continue;
          }
          v += text.slice(pos, idx);
          if (ch === ',') { pos = idx + 1; ended = COMMA; break; }
          pos = idx + 1; line++; ended = LINE_BREAK; break;
        }
        val = v;
      }
      fields.push(val);
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
