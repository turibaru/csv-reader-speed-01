[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/turibaru/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/turibaru/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# Fast CSV reader — csv-reader-speed-01

A make.fun entry for "Read broken CSV files faster, 21 November 2026": a
drop-in replacement for csv-reader 1.0.0 that returns exactly the same
answer for every input, much faster.

## What it does

`run(input)` reads `{text, header}` exactly the way csv-reader 1.0.0 does
and answers `{columns, rows, errors}`: the header record (or `null`), every
other record as an array of strings cut or padded to the first record's
width, and an error for every broken thing met, in the order met. Every rule
of the reference is kept: a U+FEFF at the very start is dropped, a line left
with no characters is no record, a CR outside quotes that is not followed
by LF is dropped (`stray_cr`), a field that opens with a quote runs to the
next quote that is not doubled (`""` inside it is one quote, each CRLF or
lone CR inside it is one LF), what follows its closing quote up to the next
comma or line break is appended as it stands (`quote_junk`), a quote that
never closes is read as a literal and the text after it is read again as an
unquoted field (`unterminated_quote`), a quote inside an unquoted field is
literal, fields stay strings, and each error carries the 1-based line its
record starts on and the record's index in rows (`null` for the header).

## How it is fast

It never builds a field one character at a time, and it never builds the
answer as an object at all. A record is read in stretches: each stretch is
a run of unquoted fields up to the next double quote, or up to the line
break when no quote comes first, and a whole run of fields is emitted as
one JSON piece (`'"' + run.replaceAll(',', '","') + '"'`), so no per-field
string or array entry is ever allocated for clean fields — about 720k
field allocations disappear. Stray CRs in a stretch are counted and
stripped only when the stretch holds one, and a CRLF end is peeled off
first. Only the field that actually holds a quote is parsed on its own: a
quoted field is found with `indexOf('"')`, doubled quotes are skipped in
place, and its content is only rewritten (`""` to `"`, CR or CRLF to LF)
when it actually holds one of those. The answer for a case is emitted
directly as JSON text (`runText`), which also skips the
`JSON.stringify` of an 11 MB answer object — the driver only joins the
six case texts. Every error of one record shares that record's start line
and row, so errors are pushed straight into the output array as they are
met. Verified byte-identical to csv-reader 1.0.0 on the practice set, on
18 freshly drawn cases and on 3,000 random broken-CSV inputs.

## How to run

Node 22 or later, no dependencies, no network:

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir> node main.ts
```

`main.ts` reads every case from `cases.json`, answers each one alone with
`runText()` from `solve.js`, and writes `answers.json`. Outside a container the
two environment variables stand in for `/input` and `/output`; without them
it reads `/input/cases.json` and writes `/output/answers.json`. It turns
V8's incremental marking off before importing `solve.js`, as the house
baseline does. `run()` (same result, parsed back to an object) is kept in
`solve.js` for testing.

## Files

- `solve.js` — the fast reader; `runText(input)` is the whole entry point
  (emits the answer as JSON text); `run(input)` returns the same answer
  as an object
- `main.ts` — the driver the harness runs
- `package.json` — `{"type": "module"}`, like the house baseline's
- `README.md` — this file
- `LICENSE` — MIT
- `.makefun/owner.json` — the payout wallet that claims this repository
