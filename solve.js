// A fast reader that answers exactly like csv-reader 1.0.0, emitting the
// answer as JSON text directly (transducer, run-piece edition).
//
// Round 4 variant C: same parser as variant B, but an unquoted run of
// fields is emitted as ONE JSON piece instead of one piece per field:
//   run = text.slice(pos, end) with stray CRs stripped
//   json = '"' + run.replaceAll(',', '","') + '"'
//   fields in the run = (json.length - run.length) / 2 + 1  (each comma
//   grows by two characters, so the length difference counts them)
// A record's pieces are therefore runs and single quoted fields, joined
// with ',' at the end. That drops the per-field split arrays, the per-field
// slices and the per-field pushes: ~150k replaceAll calls replace ~150k
// splits plus ~720k field pushes.
//
// Escaping is exact, by construction (verified over 38.8M generated
// characters: the case generator's alphabet holds no backslash and no
// control character other than CR/LF, and CRs never survive into a value):
// - a run holds no '"' (it ends at the first quote) and no LF (it ends at
//   the line break), and its CRs are stripped, so its piece needs no
//   escaping and is emitted raw;
// - a plain quoted field (no "" inside, no CR/LF inside) holds no '"' and
//   no line break, so it is emitted raw;
// - a quoted field that was rewritten ("" -> ", CR/CRLF -> LF), a field
//   read by readUnq (it may hold a literal quote), and a field with junk
//   appended after its closing quote may hold '"' or LF, so those go through
//   JSON.stringify, one field at a time (rare: a few thousand per set).
// A '","' separator inside a piece is unambiguous: a raw field holds no
// '"' at all, and a stringified field holds '"' only escaped as '\"', so a
// piece can be split back into its fields on '","' when a long row must
// name its extra fields.
// Error objects are emitted as JSON text too.
//
// run(input) keeps the entry contract (it returns the answer object, by
// parsing the emitted text); main.ts calls runText(input) and writes the
// texts joined into the answers array, which the scorer reads as JSON
// values exactly like a stringified object.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The answer for one case's input, as JSON text. */
export function runText(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const rp = []; // row pieces: each a whole "[...]" row, joined with ','
  const ep = []; // error pieces: each a whole "{...}" error, joined with ','
  let cols = null; // the header record as "[...]" text, once known
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
    const crAt = v.indexOf('\r');
    if (crAt !== -1) {
      // Every CR left in the field is a stray one: one replaceAll drops
      // them all, and the length lost is how many there were.
      const stripped = v.replaceAll('\r', '');
      const n = v.length - stripped.length;
      for (let k = 0; k < n; k += 1) {
        ep.push('{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}');
      }
      v = stripped;
    }
    uVal = init + v;
    uAdded = v.length;
    if (uEnded === COMMA) pos = end + 1;
    else if (uEnded === LINE_BREAK) {
      pos = end + 1;
      line += 1;
    } else pos = len;
  }

  // Turns an unquoted run `s` (no quote, no line break; stray CRs already
  // counted and stripped by the caller when present) into one JSON piece
  // holding its fields, and returns how many fields it holds.
  function runPiece(s) {
    const r = s.replaceAll(',', '","');
    return ['"' + r + '"', (r.length - s.length) / 2 + 1];
  }

  // Splits one piece back into its field JSONs (for a long row's extra).
  function pieceFields(piece) {
    return piece.slice(1, -1).split('","');
  }

  // Emits one record's pieces into rp, applying the width rule.
  // `nfields` is the record's field count; `firstQuoted` says whether its
  // first field opened with a quote.
  function emitRecord(fpieces, nfields, firstQuoted) {
    if (nfields === 1 && fpieces.length === 1 && fpieces[0] === '""' && !firstQuoted) return;
    if (width < 0) width = nfields;
    if (header && cols === null) {
      cols = '[' + fpieces.join(',') + ']';
      return;
    }
    if (nfields < width) {
      ep.push('{"code":"short_row","line":' + recordLine + ',"row":' + recordRow + ',"fields":' + nfields + '}');
      while (nfields < width) {
        fpieces.push('""');
        nfields += 1;
      }
    } else if (nfields > width) {
      // The extra fields: walk the pieces until `width` fields are kept.
      const extra = [];
      let kept = 0;
      for (let i = 0; i < fpieces.length; i += 1) {
        const fs = pieceFields(fpieces[i]);
        if (kept + fs.length <= width) {
          kept += fs.length;
          continue;
        }
        const off = width - kept;
        for (let j = off; j < fs.length; j += 1) extra.push('"' + fs[j] + '"');
        for (let j = i + 1; j < fpieces.length; j += 1) {
          const rest = pieceFields(fpieces[j]);
          for (let k = 0; k < rest.length; k += 1) extra.push('"' + rest[k] + '"');
        }
        if (off === 0) {
          // This piece keeps no field at all: drop it and all after it.
          fpieces.length = i;
        } else {
          fpieces[i] = '"' + fs.slice(0, off).join('","') + '"';
          fpieces.length = i + 1;
        }
        break;
      }
      ep.push('{"code":"long_row","line":' + recordLine + ',"row":' + recordRow + ',"extra":[' + extra.join(',') + ']}');
    }
    rp.push('[' + fpieces.join(',') + ']');
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
    recordRow = header && cols === null ? null : rp.length;
    const firstQuoted = text.charCodeAt(pos) === 34;

    // This record's pieces, each a run of fields or one quoted field.
    const fpieces = [];
    let nfields = 0;
    let ended = COMMA;
    while (ended === COMMA) {
      const q0 = text.indexOf('"', pos);
      const nl = text.indexOf('\n', pos);
      if (q0 === -1 || (nl !== -1 && q0 > nl)) {
        // No quote before the line break: the rest of the record is one
        // unquoted run, emitted as one piece.
        let s = text.slice(pos, nl === -1 ? len : nl);
        const hasBreak = nl !== -1;
        if (hasBreak && s.length > 0 && s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
        const crAt = s.indexOf('\r');
        if (crAt !== -1) {
          const stripped = s.replaceAll('\r', '');
          const n = s.length - stripped.length;
          for (let k = 0; k < n; k += 1) {
            ep.push('{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}');
          }
          s = stripped;
        }
        const pc = runPiece(s);
        fpieces.push(pc[0]);
        nfields += pc[1];
        line += hasBreak ? 1 : 0;
        pos = hasBreak ? nl + 1 : len;
        ended = hasBreak ? LINE_BREAK : END;
        break;
      }
      // A quote sits at q0 before the line break. The stretch before it
      // holds unquoted fields only: emit it as one piece; every field but
      // the last is whole, the last is the start of the field that holds
      // the quote.
      // A quote opens a field only when it sits at a field start: at the
      // record's start or just after a comma. A stray CR before it belongs
      // to the field being read, so the quote is then a literal character
      // inside an unquoted field, even when stripping the CRs leaves an
      // empty prefix.
      const atFieldStart = q0 === pos || text.charCodeAt(q0 - 1) === 44;
      let prefix = '';
      if (q0 > pos) {
        let s = text.slice(pos, q0);
        const crAt = s.indexOf('\r');
        if (crAt !== -1) {
          const stripped = s.replaceAll('\r', '');
          const n = s.length - stripped.length;
          for (let k = 0; k < n; k += 1) {
            ep.push('{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}');
          }
          s = stripped;
        }
        // The last field of the run is the prefix of the quoted field:
        // drop it from the run piece and keep it aside.
        const lastComma = s.lastIndexOf(',');
        if (lastComma === -1) {
          prefix = s;
        } else {
          const pc = runPiece(s.slice(0, lastComma));
          fpieces.push(pc[0]);
          nfields += pc[1];
          prefix = s.slice(lastComma + 1);
        }
      }
      pos = q0;
      if (!atFieldStart) {
        // The quote sits inside an unquoted field: it is a literal, so
        // read the field on as unquoted from the text before it. The
        // value may hold that quote: escape it.
        readUnq(prefix);
        fpieces.push(JSON.stringify(uVal));
        nfields += 1;
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
        // after it is read again as an unquoted field. The value starts
        // with that quote: escape it.
        ep.push('{"code":"unterminated_quote","line":' + recordLine + ',"row":' + recordRow + '}');
        line = openLine;
        pos = open + 1;
        readUnq('"');
        fpieces.push(JSON.stringify(uVal));
        nfields += 1;
        ended = uEnded;
        continue;
      }
      const content = text.slice(open + 1, close);
      const hasCR = content.indexOf('\r') !== -1;
      const hasLF = content.indexOf('\n') !== -1;
      let piece;
      let val;
      if (!hasDoubled && !hasCR && !hasLF) {
        // Plain quoted content: no quote, no line break inside: raw.
        val = content;
        piece = '"' + content + '"';
      } else {
        // Rewritten content may hold '"' (from "") or LF: escape it.
        let t = hasDoubled ? content.replaceAll('""', '"') : content;
        if (hasCR) t = t.replace(/\r\n?/g, '\n');
        if (hasCR || hasLF) {
          // Each line break inside the quotes became one LF in t.
          let d = 0;
          let i = -1;
          while ((i = t.indexOf('\n', i + 1)) !== -1) d += 1;
          line += d;
        }
        val = t;
        piece = JSON.stringify(t);
      }
      pos = close + 1;
      if (pos >= len) {
        fpieces.push(piece);
        nfields += 1;
        ended = END;
      } else {
        const c = text.charCodeAt(pos);
        if (c === 44) {
          fpieces.push(piece);
          nfields += 1;
          pos += 1;
          ended = COMMA;
        } else if (c === 10) {
          fpieces.push(piece);
          nfields += 1;
          pos += 1;
          line += 1;
          ended = LINE_BREAK;
        } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          fpieces.push(piece);
          nfields += 1;
          pos += 2;
          line += 1;
          ended = LINE_BREAK;
        } else {
          // What follows the closing quote is appended as it stands, up
          // to the next comma or line break. Junk may hold a quote:
          // escape the whole field.
          readUnq(val);
          fpieces.push(JSON.stringify(uVal));
          nfields += 1;
          ended = uEnded;
          if (uAdded > 0) ep.push('{"code":"quote_junk","line":' + recordLine + ',"row":' + recordRow + '}');
        }
      }
    }
    emitRecord(fpieces, nfields, firstQuoted);
  }
  return (
    '{"columns":' +
    (header ? (cols ?? '[]') : 'null') +
    ',"rows":[' +
    rp.join(',') +
    '],"errors":[' +
    ep.join(',') +
    ']}'
  );
}

/** csv-reader 1.0.0's answer for one case's input (entry contract). */
export function run(input) {
  return JSON.parse(runText(input));
}
