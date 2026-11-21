// A fast reader that answers exactly like csv-reader 1.0.0.
//
// The answers are csv-reader 1.0.0's reading of {text, header}: the header
// record (or null), every other record as an array of strings cut or padded
// to the first record's width, and an error for every broken thing met, in
// the order met. This module keeps every rule of that reader -- a U+FEFF at
// the very start is dropped, a line left with no characters is no record, a
// CR outside quotes that is not followed by LF is dropped (stray_cr), a
// field that opens with a quote runs to the next quote that is not doubled
// ("" inside it is one quote, each CRLF or lone CR inside it is one LF),
// what follows its closing quote up to the next comma or line break is
// appended as it stands (quote_junk), a quote that never closes is read as
// a literal and the text after it is read again as an unquoted field
// (unterminated_quote), a quote inside an unquoted field is literal, fields
// stay strings, and each error carries the 1-based line its record starts
// on and the record's index in rows (null for the header).
//
// It is faster than the reference because it never builds a field one
// character at a time. A record is read in stretches: each stretch is a run
// of unquoted fields up to the next double quote, or up to the line break
// when no quote comes first, and the whole stretch is split in bulk
// (String split runs in native code). Stray CRs in a stretch are counted
// and stripped only when the stretch holds one, and a CRLF end is peeled
// off first. Only the field that actually holds a quote is parsed on its
// own: a quoted field is found with indexOf('"'), doubled quotes are
// skipped in place, and its content is only rewritten ("" to ", CR or CRLF
// to LF) when it actually holds one of those; a quote inside an unquoted
// field is read on as an unquoted field starting from the text before it.
// Every error of one record shares that record's start line and row, so
// errors are pushed straight into the output array as they are met, in the
// order met, with the record's short_row or long_row last.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;

  // Scratch outputs of readUnq, so it returns nothing per call.
  let uVal = '';
  let uEnded = END;
  let uAdded = 0;

  // Reads an unquoted field starting at pos, onto `init`: commas and line
  // breaks end it, a CR not followed by LF is dropped (stray_cr). Sets
  // uVal (the field), uEnded (how it ended), uAdded (the characters kept
  // by this call) and moves pos and line past what it read.
  function readUnq(init) {
    const comma = text.indexOf(',', pos);
    const lf = text.indexOf('\n', pos);
    let end;
    let fieldEnd;
    if (comma !== -1 && (lf === -1 || comma < lf)) {
      end = comma;
      fieldEnd = comma;
      uEnded = COMMA;
    } else if (lf !== -1) {
      end = lf;
      // A CR just before the LF is the CRLF line break, not part of the field.
      fieldEnd = lf > pos && text.charCodeAt(lf - 1) === 13 ? lf - 1 : lf;
      uEnded = LINE_BREAK;
    } else {
      end = len;
      fieldEnd = len;
      uEnded = END;
    }
    let v = text.slice(pos, fieldEnd);
    if (v.indexOf('\r') !== -1) {
      // Every CR left in the field is a stray one: count them, drop them.
      let n = 0;
      let i = -1;
      while ((i = v.indexOf('\r', i + 1)) !== -1) n += 1;
      for (let k = 0; k < n; k += 1) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      v = v.replaceAll('\r', '');
    }
    uVal = init + v;
    uAdded = v.length;
    if (uEnded === COMMA) pos = end + 1;
    else if (uEnded === LINE_BREAK) {
      pos = end + 1;
      line += 1;
    } else pos = len;
  }

  // Takes a record's fields: a line that held only an empty unquoted field
  // is no record; the first record sets the width (and is the header when
  // header is true); later records are padded (short_row) or cut (long_row)
  // to that width.
  function finish(fields, firstQuoted) {
    if (fields.length === 1 && fields[0] === '' && !firstQuoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const firstQuoted = text.charCodeAt(pos) === 34;

    const fields = [];
    let ended = COMMA;
    while (ended === COMMA) {
      const q0 = text.indexOf('"', pos);
      const nl = text.indexOf('\n', pos);
      if (q0 === -1 || (nl !== -1 && q0 > nl)) {
        // No quote before the line break: the rest of the record is
        // unquoted fields, split in bulk.
        let s = text.slice(pos, nl === -1 ? len : nl);
        const hasBreak = nl !== -1;
        if (hasBreak && s.length > 0 && s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
        if (s.indexOf('\r') !== -1) {
          let n = 0;
          let i = -1;
          while ((i = s.indexOf('\r', i + 1)) !== -1) n += 1;
          for (let k = 0; k < n; k += 1) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          s = s.replaceAll('\r', '');
        }
        const parts = s.split(',');
        for (let i = 0; i < parts.length; i += 1) fields.push(parts[i]);
        line += hasBreak ? 1 : 0;
        pos = hasBreak ? nl + 1 : len;
        ended = hasBreak ? LINE_BREAK : END;
        break;
      }
      // A quote sits at q0 before the line break. The stretch before it
      // holds unquoted fields only: split it in bulk; every piece but the
      // last is a whole field, the last is the start of the field that
      // holds the quote.
      // A quote opens a field only when it sits at a field start: at the
      // record's start or just after a comma. A stray CR before it belongs
      // to the field being read, so the quote is then a literal character
      // inside an unquoted field, even when stripping the CRs leaves an
      // empty prefix.
      const atFieldStart = q0 === pos || text.charCodeAt(q0 - 1) === 44;
      let prefix = '';
      if (q0 > pos) {
        let s = text.slice(pos, q0);
        if (s.indexOf('\r') !== -1) {
          let n = 0;
          let i = -1;
          while ((i = s.indexOf('\r', i + 1)) !== -1) n += 1;
          for (let k = 0; k < n; k += 1) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          s = s.replaceAll('\r', '');
        }
        const parts = s.split(',');
        for (let i = 0; i < parts.length - 1; i += 1) fields.push(parts[i]);
        prefix = parts[parts.length - 1];
      }
      pos = q0;
      if (!atFieldStart) {
        // The quote sits inside an unquoted field: it is a literal, so
        // read the field on as unquoted from the text before it.
        readUnq(prefix);
        fields.push(uVal);
        ended = uEnded;
        continue;
      }
      // The quote opens a field: run it to the next quote that is not doubled.
      const open = pos;
      const openLine = line;
      let p = open + 1;
      let hasDoubled = false;
      let close = -1;
      for (;;) {
        const q = text.indexOf('"', p);
        if (q === -1) break;
        if (text.charCodeAt(q + 1) === 34) {
          hasDoubled = true;
          p = q + 2;
          continue;
        }
        close = q;
        break;
      }
      if (close === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        line = openLine;
        pos = open + 1;
        readUnq('"');
        fields.push(uVal);
        ended = uEnded;
        continue;
      }
      const content = text.slice(open + 1, close);
      const hasCR = content.indexOf('\r') !== -1;
      const hasLF = content.indexOf('\n') !== -1;
      let v;
      if (!hasDoubled && !hasCR && !hasLF) {
        v = content;
      } else {
        let t = hasDoubled ? content.replaceAll('""', '"') : content;
        if (hasCR) t = t.replace(/\r\n?/g, '\n');
        v = t;
        if (hasCR || hasLF) {
          // Each line break inside the quotes became one LF in t.
          let d = 0;
          let i = -1;
          while ((i = t.indexOf('\n', i + 1)) !== -1) d += 1;
          line += d;
        }
      }
      pos = close + 1;
      if (pos >= len) {
        fields.push(v);
        ended = END;
      } else {
        const c = text.charCodeAt(pos);
        if (c === 44) {
          fields.push(v);
          pos += 1;
          ended = COMMA;
        } else if (c === 10) {
          fields.push(v);
          pos += 1;
          line += 1;
          ended = LINE_BREAK;
        } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          fields.push(v);
          pos += 2;
          line += 1;
          ended = LINE_BREAK;
        } else {
          // What follows the closing quote is appended as it stands, up
          // to the next comma or line break.
          readUnq(v);
          fields.push(uVal);
          ended = uEnded;
          if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }
    }
    finish(fields, firstQuoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
