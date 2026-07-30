# GXPN Study Index

A tiny local web app for building a GIAC-exam-style index while studying for GXPN:
concept → sub-concept → book/page reference → notes, with autocomplete that surfaces
existing (and near-duplicate) terms as you type, so your index doesn't fragment into
"Buffer Overflow" vs "Buffer Overflows" vs "Stack Buffer Overflow".

Stdlib only, except PDF export, which uses reportlab:

```
sudo apt-get install python3-reportlab   # Debian/Ubuntu; see note below otherwise
```

The app runs fine without it — you just won't be able to generate the PDF (the rest
of the UI, including the browser print view, doesn't need it).

## Run it

```
python3 server.py        # defaults to port 8765
python3 server.py 9000    # or pick a port
```

Open http://127.0.0.1:8765 in a browser. The server is threaded — browsers open
speculative connections and send nothing on them, which wedges a single-threaded
Python HTTP server until it's killed.

## Import an existing index

If you already have a course index in Word — two-column tables of
`Term | 1:63-67, 1:69-71, 2:60`, the "book number : page number" notation SANS
indexes use — `import_docx.py` loads it in:

```
python3 import_docx.py Index_SEC660_K01_04.docx --dry-run   # report only
python3 import_docx.py Index_SEC660_K01_04.docx
```

Each individual `book:page` reference becomes one entry — the same grain the UI
adds one at a time — so you can hang a note off a specific page later. Book
numbers are added to the Book/Source list as bare numbers (`1`–`5`), which is
what makes references read `1:63-67` like the source document; pass
`--book-prefix "Book "` for `Book 1:63-67` instead. The importer reuses the
API's duplicate rule, so re-running it adds nothing and merges cleanly into an
index you've already started (existing entries are snapshotted to
`data/backups/` first). Terms that differ only in case collapse into the one
that appears first.

## How it works

- Every entry has: **Concept**, **Sub-concept** (optional, second level of granularity),
  **Book/Source**, **Page**, **Notes**.
- As you type a concept or sub-concept, a dropdown shows existing matches — exact
  substring matches first, then fuzzy/typo-tolerant matches (marked with `~`) — so you
  can see whether to reuse an existing term or intentionally add a new one. A panel
  below the form also lists every existing reference already logged under the concept
  you're typing.
- Submitting an entry that exactly matches an existing one (same concept, sub-concept,
  book, and page) is flagged as a duplicate instead of silently added twice — you can
  still add it anyway if it's intentional (e.g. two separate notes on the same page).
  Same concept with a *different* page/book is not a duplicate — that's just another
  reference, and it stacks under the same concept in the index.
- The header tracks how far along you are: **what percent of references carry a note
  or a sub-concept**, with a bar that fills as you work, plus what percent of concepts
  have at least one annotated reference. The label rounds; the bar doesn't, so a
  handful of annotations out of a thousand still nudges it. Hovering gives the raw
  counts. Excluding an un-annotated reference raises the percentage — pruning counts
  as progress.
- Every row in **All entries** carries a small expander next to the concept showing
  how many times that concept appears (`▸ 34`). Click it to open a list, right under
  the row, of **every reference for that concept** — always sorted book → page
  whatever the table is sorted by, and always the full set even when a filter is
  hiding some. Each line shows its sub-concept (or *no sub-concept*), with a tally of
  the sub-concepts used so far (`Bypass on Linux 3 · unlabelled 31`), so you can see
  which references align with labels you've already made and which are still loose.
  The row you opened it from is tagged **this row**. **Exclude** drops a reference you
  decide isn't worth keeping, **Edit** loads it into the form, and *select all for
  labelling* pushes the whole concept into the selection for a bulk sub-concept.
  Several lists can be open at once; the toolbar offers to collapse them.
- **Hide annotated** drops every reference that already has a note or a sub-concept,
  leaving just what's left to do (the tick-box says how many it's hiding). It stacks
  with the search box, and rows vanish from the list as you finish them. It does *not*
  touch the per-concept lists — those still show every reference, which is the point of
  them. The header percentages always describe the whole index, not the filtered view.
- Click a column header to sort; click again to reverse. **Shift-click** a second
  header to sort by more than one column — the headers then show their priority
  (`Book ▲1`, `Page ▲2`). Book and Page sort numerically, not alphabetically, so 9
  comes before 10. Columns you haven't picked still break ties in book → page order,
  so sorting by Book alone reads as reading order through that book. Sorting by
  Sub-concept ascending brings the not-yet-labelled references to the top.
- Tick rows and set a **sub-concept for the whole selection** in one go — **shift-click** a second row checkbox to take the
  entire run in between, which is the quick way to label a block of consecutive
  pages. Applying an empty value clears the sub-concept again. The selection is kept
  as you re-sort or re-filter, and the count in the bar is always the true total.
- Every add/edit/delete rewrites `data/index.csv` (the source of truth — you can open
  it in Excel/Sheets too) and regenerates `INDEX.md`, a grouped Markdown view of the
  whole index for reading during the open-book exam.
- The **Printable** tab has two on-screen sub-views (Full with notes, Simple
  concept→location lookup) plus a **Download PDF** button that calls the server to
  generate one combined PDF — Full section, then a page break, then the Simple section
  as a classic letter-grouped, banded-row lookup table. This is a proper server-rendered
  PDF (reportlab), not a browser print-to-PDF, so pagination and row banding are
  reliable regardless of browser. "Print this view (browser)" still exists for a quick
  on-screen print of just the current sub-view.
- `data/` and `INDEX.md` are gitignored — this repo tracks the tool, not your notes.
  `*.docx` is also gitignored, in case you drop in course-derived reference material.

## Files

- `server.py` — stdlib HTTP server + API (`/api/entries`,
  `/api/entries/subconcept` for bulk labelling, `/api/meta`, `/api/sources`,
  `/api/markdown`, `/api/pdf`)
- `pdf_export.py` — builds the combined PDF with reportlab
- `import_docx.py` — one-shot importer for a Word-format course index (see above)
- `static/` — the UI (plain HTML/CSS/JS, no build step)
- `data/index.csv` — generated on first run
- `data/sources.json` — your configured Book/Source list (via "manage list" in the UI)
- `data/backups/` — automatic snapshots taken before "Clear all entries" wipes anything
- `INDEX.md` — generated/updated on every change
