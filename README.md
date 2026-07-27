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

Open http://127.0.0.1:8765 in a browser.

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

- `server.py` — stdlib HTTP server + API (`/api/entries`, `/api/meta`, `/api/sources`,
  `/api/markdown`, `/api/pdf`)
- `pdf_export.py` — builds the combined PDF with reportlab
- `static/` — the UI (plain HTML/CSS/JS, no build step)
- `data/index.csv` — generated on first run
- `data/sources.json` — your configured Book/Source list (via "manage list" in the UI)
- `data/backups/` — automatic snapshots taken before "Clear all entries" wipes anything
- `INDEX.md` — generated/updated on every change
