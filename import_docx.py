#!/usr/bin/env python3
"""
Import a Word-format course index into the GXPN Study Index.

Reads a .docx whose body is two-column tables of

    Term | 1:63-67, 1:69-71, 2:60

(the "book number : page number" notation SANS course indexes use), and turns
each individual book:page reference into one entry — the same grain the web UI
adds one at a time. Re-running is safe: references already in data/index.csv are
skipped, not duplicated.

    python3 import_docx.py Index_SEC660_K01_04.docx
    python3 import_docx.py Index_SEC660_K01_04.docx --dry-run
    python3 import_docx.py idx.docx --book-prefix "Book "   # -> "Book 1:63-67"

Stdlib only. Existing entries are snapshotted to data/backups/ before writing.
"""
import argparse
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

import server

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# "1:63-67" / "2:60" — book number, colon, then a page or an inclusive range.
REF_RE = re.compile(r"^(\d+):(\d+(?:-\d+)?)$")


def cell_text(el):
    """All text in a paragraph/cell, ignoring Word's run splitting."""
    return "".join(t.text or "" for t in el.iter(W + "t"))


def normalize(s):
    """Word litters real documents with nbsp and typographic dashes."""
    return (
        s.replace("\xa0", " ")
        .replace("–", "-")
        .replace("—", "-")
        .replace("−", "-")
        .strip()
    )


def read_rows(path):
    """Every two-column table row in the document, in document order."""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    rows = []
    for tbl in root.iter(W + "tbl"):
        for tr in tbl.findall(W + "tr"):
            cells = [normalize(cell_text(tc)) for tc in tr.findall(W + "tc")]
            rows.append(cells)
    return rows


def parse_rows(rows):
    """Rows -> ([(term, book, page)], [warning]) with book/page kept as text."""
    refs = []
    warnings = []
    for i, cells in enumerate(rows, 1):
        if len(cells) != 2:
            warnings.append(f"row {i}: expected 2 columns, got {len(cells)} — skipped")
            continue
        term, raw = cells
        if not term:
            warnings.append(f"row {i}: no term — skipped")
            continue
        if not raw:
            warnings.append(f"row {i}: {term!r} has no references — skipped")
            continue
        for tok in (t.strip() for t in raw.split(",")):
            if not tok:
                continue
            m = REF_RE.match(tok)
            if not m:
                warnings.append(f"row {i}: {term!r} — unparsed reference {tok!r} — skipped")
                continue
            refs.append((term, m.group(1), m.group(2)))
    return refs, warnings


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("docx", help="path to the .docx index to import")
    ap.add_argument(
        "--book-prefix",
        default="",
        help='text prepended to each book number in the Book/Source field (default: none, so refs read "1:63-67")',
    )
    ap.add_argument("--dry-run", action="store_true", help="report what would be imported, write nothing")
    args = ap.parse_args()

    if not os.path.exists(args.docx):
        sys.exit(f"no such file: {args.docx}")

    refs, warnings = parse_rows(read_rows(args.docx))
    if not refs:
        sys.exit("no book:page references found — is this a two-column course index?")

    terms = {t for t, _, _ in refs}
    books = sorted({b for _, b, _ in refs}, key=int)
    print(f"Parsed {len(refs)} references across {len(terms)} terms, books {', '.join(books)}.")
    for w in warnings:
        print(f"  warning: {w}")

    existing = server.load_entries()
    new = []
    skipped = 0
    for term, book, page in refs:
        entry = {
            "concept": term,
            "subconcept": "",
            "book": f"{args.book_prefix}{book}",
            "page": page,
            "notes": "",
        }
        # Same dedupe rule the API uses, applied against what we're adding too,
        # so a term repeated in the document doesn't land twice.
        if server.find_duplicate(existing + new, entry):
            skipped += 1
            continue
        new.append(entry)

    print(f"{len(new)} to add, {skipped} already present (or repeated in the document).")
    if args.dry_run:
        print("Dry run — nothing written.")
        return
    if not new:
        print("Nothing to do.")
        return

    server.backup_entries(existing)
    entries = list(existing)
    next_id = int(server.next_id(entries))
    for offset, entry in enumerate(new):
        entry["id"] = str(next_id + offset)
        entries.append(entry)
    server.write_entries(entries)
    server.regenerate_markdown(entries)

    sources = server.write_sources(server.load_sources() + [f"{args.book_prefix}{b}" for b in books])

    print(f"Wrote {len(entries)} entries to {server.CSV_PATH}")
    print(f"Regenerated {server.MD_PATH}")
    print(f"Book/Source list is now: {', '.join(sources)}")


if __name__ == "__main__":
    main()
