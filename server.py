#!/usr/bin/env python3
"""
GXPN Study Index — a tiny local web app for building a GIAC-exam-style index.

Stores entries (concept, subconcept, book, page, notes) in data/index.csv
and regenerates INDEX.md on every change. Stdlib only, except PDF export
(pdf_export.py) which needs reportlab — apt: python3-reportlab. Run with:

    python3 server.py [port]

Then open http://127.0.0.1:8765 (or whichever port you passed).
"""
import csv
import json
import os
import re
import sys
import threading
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

try:
    from pdf_export import generate_pdf
    PDF_AVAILABLE = True
except ImportError:
    PDF_AVAILABLE = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
CSV_PATH = os.path.join(DATA_DIR, "index.csv")
SOURCES_PATH = os.path.join(DATA_DIR, "sources.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
MD_PATH = os.path.join(BASE_DIR, "INDEX.md")

FIELDS = ["id", "concept", "subconcept", "book", "page", "notes"]

lock = threading.Lock()


def ensure_csv():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(CSV_PATH):
        with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=FIELDS).writeheader()


def load_entries():
    ensure_csv()
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def ensure_sources():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(SOURCES_PATH):
        with open(SOURCES_PATH, "w", encoding="utf-8") as f:
            json.dump([], f)


def load_sources():
    ensure_sources()
    with open(SOURCES_PATH, encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            return []
    return [s for s in data if isinstance(s, str)]


def write_sources(sources):
    cleaned = []
    seen = set()
    for s in sources:
        s = (s or "").strip()
        if s and s.lower() not in seen:
            seen.add(s.lower())
            cleaned.append(s)
    cleaned.sort(key=str.lower)
    with open(SOURCES_PATH, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, indent=2)
    return cleaned


def match_source(book, sources):
    for s in sources:
        if s.lower() == book.lower():
            return s
    return None


def backup_entries(entries):
    """Snapshot current entries before a destructive bulk operation."""
    if not entries:
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(BACKUP_DIR, f"index-{stamp}.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        for e in entries:
            writer.writerow({k: e.get(k, "") for k in FIELDS})


def write_entries(entries):
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        for e in entries:
            writer.writerow({k: e.get(k, "") for k in FIELDS})


def natural_sort_key(value):
    """Numbers first, in numeric order ("9" before "10"), then everything else."""
    m = re.match(r"^\s*(\d+)", value or "")
    if m:
        return (0, int(m.group(1)), value or "")
    return (1, 0, (value or "").lower())


def sorted_entries(entries):
    return sorted(
        entries,
        key=lambda e: (
            (e.get("concept") or "").lower(),
            (e.get("subconcept") or "").lower(),
            # Book before page: a concept's references should read in book order
            # (1:4, 1:14, 2:74), not interleaved by page number across books.
            natural_sort_key(e.get("book")),
            natural_sort_key(e.get("page")),
        ),
    )


def slugify(text):
    s = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    s = re.sub(r"[\s_]+", "-", s)
    return s or "section"


def norm(s):
    return (s or "").strip().lower()


def next_id(entries):
    ids = [int(e["id"]) for e in entries if str(e.get("id", "")).isdigit()]
    return str(max(ids) + 1) if ids else "1"


def ref_string(book, page):
    book = (book or "").strip()
    page = (page or "").strip()
    if book and page:
        return f"{book}:{page}"
    if book:
        return book
    if page:
        return f"p.{page}"
    return ""


def regenerate_markdown(entries):
    entries = sorted_entries(entries)
    concepts = []
    seen = set()
    for e in entries:
        c = e.get("concept") or ""
        if c not in seen:
            seen.add(c)
            concepts.append(c)

    lines = []
    lines.append("# GXPN Study Index")
    lines.append("")
    lines.append("_Auto-generated from `data/index.csv` by the web UI — don't hand-edit, it'll be overwritten._")
    lines.append("")
    lines.append(f"**Entries:** {len(entries)}  |  **Concepts:** {len(concepts)}")
    lines.append("")
    lines.append("## Table of Contents")
    for c in concepts:
        lines.append(f"- [{c}](#{slugify(c)})")
    lines.append("")

    for c in concepts:
        lines.append(f"## {c}")
        c_entries = [e for e in entries if e.get("concept") == c]

        no_sub = [e for e in c_entries if not (e.get("subconcept") or "").strip()]
        for e in no_sub:
            ref = ref_string(e.get("book"), e.get("page")) or "—"
            note = e.get("notes") or ""
            lines.append(f"- **{ref}** — {note}")

        subs = []
        seen_sub = set()
        for e in c_entries:
            s = (e.get("subconcept") or "").strip()
            if s and s not in seen_sub:
                seen_sub.add(s)
                subs.append(s)

        for s in subs:
            lines.append(f"### {s}")
            for e in [x for x in c_entries if (x.get("subconcept") or "").strip() == s]:
                ref = ref_string(e.get("book"), e.get("page")) or "—"
                note = e.get("notes") or ""
                lines.append(f"- **{ref}** — {note}")
        lines.append("")

    with open(MD_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip() + "\n")


def build_meta(entries):
    concept_counts = {}
    sub_by_concept = {}
    books = set()
    for e in entries:
        c = e.get("concept") or ""
        if not c:
            continue
        concept_counts[c] = concept_counts.get(c, 0) + 1
        s = (e.get("subconcept") or "").strip()
        if s:
            sub_by_concept.setdefault(c, set()).add(s)
        b = (e.get("book") or "").strip()
        if b:
            books.add(b)

    concepts = [{"name": c, "count": n} for c, n in sorted(concept_counts.items(), key=lambda x: x[0].lower())]
    sub_map = {c: sorted(s, key=str.lower) for c, s in sub_by_concept.items()}
    return {
        "concepts": concepts,
        "subconceptsByConcept": sub_map,
        "books": sorted(books, key=str.lower),
    }


def find_duplicate(entries, entry, exclude_id=None):
    for e in entries:
        if exclude_id is not None and e.get("id") == exclude_id:
            continue
        if (
            norm(e.get("concept")) == norm(entry.get("concept"))
            and norm(e.get("subconcept")) == norm(entry.get("subconcept"))
            and norm(e.get("book")) == norm(entry.get("book"))
            and norm(e.get("page")) == norm(entry.get("page"))
        ):
            return e
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep the console quiet

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, data, content_type, filename=None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            self._send_file(os.path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8")
        elif path == "/app.js":
            self._send_file(os.path.join(STATIC_DIR, "app.js"), "application/javascript; charset=utf-8")
        elif path == "/style.css":
            self._send_file(os.path.join(STATIC_DIR, "style.css"), "text/css; charset=utf-8")
        elif path == "/favicon.png":
            self._send_file(os.path.join(STATIC_DIR, "favicon.png"), "image/png")
        elif path == "/logo.png":
            self._send_file(os.path.join(STATIC_DIR, "logo.png"), "image/png")
        elif path == "/api/entries":
            with lock:
                entries = sorted_entries(load_entries())
            self._send_json(entries)
        elif path == "/api/meta":
            with lock:
                entries = load_entries()
            self._send_json(build_meta(entries))
        elif path == "/api/sources":
            with lock:
                sources = load_sources()
            self._send_json({"sources": sources})
        elif path == "/api/markdown":
            with lock:
                try:
                    with open(MD_PATH, encoding="utf-8") as f:
                        md = f.read()
                except FileNotFoundError:
                    md = ""
            self._send_json({"markdown": md})
        elif path == "/api/pdf":
            if not PDF_AVAILABLE:
                self._send_json(
                    {"error": "PDF export needs the reportlab package. Install it with: "
                              "sudo apt-get install python3-reportlab"},
                    500,
                )
                return
            with lock:
                entries = sorted_entries(load_entries())
            try:
                pdf_bytes = generate_pdf(entries)
            except Exception as ex:  # noqa: BLE001 - surface any generation failure to the UI
                self._send_json({"error": f"PDF generation failed: {ex}"}, 500)
                return
            self._send_bytes(pdf_bytes, "application/pdf", filename="gxpn-study-index.pdf")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/sources":
            data = self._read_json_body()
            raw = data.get("sources")
            if not isinstance(raw, list):
                self._send_json({"error": "sources must be a list"}, 400)
                return
            with lock:
                sources = write_sources(raw)
            self._send_json({"sources": sources})
            return
        if path == "/api/entries/subconcept":
            self._bulk_set_subconcept()
            return
        if path != "/api/entries":
            self.send_response(404)
            self.end_headers()
            return
        data = self._read_json_body()
        concept = (data.get("concept") or "").strip()
        if not concept:
            self._send_json({"error": "concept is required"}, 400)
            return
        entry = {
            "concept": concept,
            "subconcept": (data.get("subconcept") or "").strip(),
            "book": (data.get("book") or "").strip(),
            "page": (data.get("page") or "").strip(),
            "notes": (data.get("notes") or "").strip(),
        }
        force = bool(data.get("force"))
        with lock:
            sources = load_sources()
            if sources:
                matched = match_source(entry["book"], sources) if entry["book"] else None
                if not matched:
                    self._send_json(
                        {"error": "Book/Source must be selected from your configured list"}, 400
                    )
                    return
                entry["book"] = matched
            entries = load_entries()
            dup = find_duplicate(entries, entry)
            if dup and not force:
                self._send_json({"duplicate": True, "existing": dup}, 409)
                return
            entry["id"] = next_id(entries)
            entries.append(entry)
            write_entries(entries)
            regenerate_markdown(entries)
            meta = build_meta(entries)
        self._send_json({"entry": entry, "meta": meta}, 201)

    def _bulk_set_subconcept(self):
        """Set (or, with an empty value, clear) the sub-concept on many entries at once.

        One CSV write and one INDEX.md regeneration for the whole batch — the point
        is labelling a block of imported references without a request per row.
        """
        data = self._read_json_body()
        ids = data.get("ids")
        if not isinstance(ids, list) or not ids:
            self._send_json({"error": "ids must be a non-empty list"}, 400)
            return
        subconcept = (data.get("subconcept") or "").strip()
        wanted = {str(i) for i in ids}
        with lock:
            entries = load_entries()
            known = {e.get("id") for e in entries}
            missing = sorted(wanted - known)
            if missing:
                self._send_json({"error": f"unknown entry ids: {', '.join(missing)}"}, 404)
                return
            updated = 0
            for e in entries:
                if e.get("id") in wanted and (e.get("subconcept") or "") != subconcept:
                    e["subconcept"] = subconcept
                    updated += 1
            if updated:
                write_entries(entries)
                regenerate_markdown(entries)
            meta = build_meta(entries)
        self._send_json({"updated": updated, "requested": len(wanted), "meta": meta})

    def do_PUT(self):
        path = urlparse(self.path).path
        m = re.match(r"^/api/entries/(\w+)$", path)
        if not m:
            self.send_response(404)
            self.end_headers()
            return
        entry_id = m.group(1)
        data = self._read_json_body()
        concept = (data.get("concept") or "").strip()
        if not concept:
            self._send_json({"error": "concept is required"}, 400)
            return
        updated = {
            "id": entry_id,
            "concept": concept,
            "subconcept": (data.get("subconcept") or "").strip(),
            "book": (data.get("book") or "").strip(),
            "page": (data.get("page") or "").strip(),
            "notes": (data.get("notes") or "").strip(),
        }
        force = bool(data.get("force"))
        with lock:
            sources = load_sources()
            if sources:
                matched = match_source(updated["book"], sources) if updated["book"] else None
                if not matched:
                    self._send_json(
                        {"error": "Book/Source must be selected from your configured list"}, 400
                    )
                    return
                updated["book"] = matched
            entries = load_entries()
            if not any(e.get("id") == entry_id for e in entries):
                self._send_json({"error": "not found"}, 404)
                return
            dup = find_duplicate(entries, updated, exclude_id=entry_id)
            if dup and not force:
                self._send_json({"duplicate": True, "existing": dup}, 409)
                return
            entries = [updated if e.get("id") == entry_id else e for e in entries]
            write_entries(entries)
            regenerate_markdown(entries)
            meta = build_meta(entries)
        self._send_json({"entry": updated, "meta": meta})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/api/entries":
            with lock:
                current = load_entries()
                backup_entries(current)
                write_entries([])
                regenerate_markdown([])
                meta = build_meta([])
            self._send_json({"ok": True, "meta": meta, "backed_up": bool(current)})
            return
        m = re.match(r"^/api/entries/(\w+)$", path)
        if not m:
            self.send_response(404)
            self.end_headers()
            return
        entry_id = m.group(1)
        with lock:
            entries = load_entries()
            new_entries = [e for e in entries if e.get("id") != entry_id]
            if len(new_entries) == len(entries):
                self._send_json({"error": "not found"}, 404)
                return
            write_entries(new_entries)
            regenerate_markdown(new_entries)
            meta = build_meta(new_entries)
        self._send_json({"ok": True, "meta": meta})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ensure_csv()
    with lock:
        regenerate_markdown(load_entries())
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"GXPN Study Index running at http://127.0.0.1:{port}")
    print(f"Data file: {CSV_PATH}")
    print(f"Markdown index: {MD_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
