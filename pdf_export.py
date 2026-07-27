"""
Server-side PDF export for the GXPN Study Index.

Produces one PDF with two sections, appended back to back:
  1. Full index   — concept / sub-concept / notes, for reading and studying.
  2. Simple index — classic back-of-book layout: alphabet-letter headings,
     a banded two-column table of term -> page refs, for fast lookup.

Requires the reportlab package (apt: python3-reportlab).
"""
import io
import re

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ACCENT = colors.HexColor("#2f6f4f")
MUTED = colors.HexColor("#555555")
BAND = colors.HexColor("#eef1ef")
BORDER = colors.HexColor("#c9cdd0")


def _esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


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


def letter_of(concept):
    c = (concept.strip()[:1] or "#").upper()
    return c if re.match(r"[A-Z]", c) else "#"


def page_sort_key(page):
    m = re.match(r"^\s*(\d+)", page or "")
    if m:
        return (0, int(m.group(1)), page or "")
    return (1, 0, (page or "").lower())


def sorted_for_pdf(entries):
    return sorted(
        entries,
        key=lambda e: (
            (e.get("concept") or "").lower(),
            (e.get("subconcept") or "").lower(),
            page_sort_key(e.get("page")),
        ),
    )


def _ordered_concepts(entries):
    seen = set()
    out = []
    for e in entries:
        c = e.get("concept") or ""
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _ordered_subconcepts(c_entries):
    seen = set()
    out = []
    for e in c_entries:
        s = (e.get("subconcept") or "").strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _build_styles():
    ss = getSampleStyleSheet()
    return {
        "doc_title": ParagraphStyle(
            "doc_title", parent=ss["Title"], fontSize=18, spaceAfter=14
        ),
        "concept": ParagraphStyle(
            "concept", parent=ss["Heading2"], fontSize=13,
            textColor=ACCENT, spaceBefore=10, spaceAfter=4,
        ),
        "sub": ParagraphStyle(
            "sub", parent=ss["Heading3"], fontSize=10.5,
            textColor=colors.black, spaceBefore=4, spaceAfter=2, leftIndent=10,
        ),
        "bullet": ParagraphStyle(
            "bullet", parent=ss["Normal"], fontSize=9.5,
            leftIndent=18, spaceAfter=3, leading=13,
        ),
        "letter": ParagraphStyle(
            "letter", parent=ss["Heading1"], fontSize=15,
            textColor=ACCENT, spaceBefore=14, spaceAfter=4,
        ),
        "cell": ParagraphStyle("cell", parent=ss["Normal"], fontSize=9, leading=12),
        "cell_sub": ParagraphStyle(
            "cell_sub", parent=ss["Normal"], fontSize=8.5,
            leading=12, textColor=MUTED, leftIndent=12,
        ),
        "cell_ref": ParagraphStyle(
            "cell_ref", parent=ss["Normal"], fontSize=8.5,
            leading=12, textColor=MUTED, alignment=2,
        ),
        "empty": ParagraphStyle("empty", parent=ss["Normal"], fontSize=10, textColor=MUTED),
    }


def _build_full_story(entries, styles):
    story = [Paragraph("GXPN Study Index &mdash; Full", styles["doc_title"])]
    concepts = _ordered_concepts(entries)
    if not concepts:
        story.append(Paragraph("Nothing indexed yet.", styles["empty"]))
        return story

    for c in concepts:
        c_entries = [e for e in entries if e.get("concept") == c]
        story.append(Paragraph(_esc(c), styles["concept"]))

        direct = [e for e in c_entries if not (e.get("subconcept") or "").strip()]
        for e in direct:
            ref = ref_string(e.get("book"), e.get("page")) or "—"
            notes = e.get("notes") or ""
            story.append(Paragraph(f"<b>{_esc(ref)}</b> &mdash; {_esc(notes)}", styles["bullet"]))

        for s in _ordered_subconcepts(c_entries):
            story.append(Paragraph(_esc(s), styles["sub"]))
            for e in [x for x in c_entries if (x.get("subconcept") or "").strip() == s]:
                ref = ref_string(e.get("book"), e.get("page")) or "—"
                notes = e.get("notes") or ""
                story.append(Paragraph(f"<b>{_esc(ref)}</b> &mdash; {_esc(notes)}", styles["bullet"]))

    return story


def _table_style(nrows):
    style = [
        ("GRID", (0, 0), (-1, -1), 0.4, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    for i in range(nrows):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), BAND))
    return TableStyle(style)


def _build_simple_story(entries, styles):
    story = [Paragraph("GXPN Study Index &mdash; Quick Lookup", styles["doc_title"])]
    concepts = _ordered_concepts(entries)
    if not concepts:
        story.append(Paragraph("Nothing indexed yet.", styles["empty"]))
        return story

    current_letter = None
    rows = []

    def flush():
        if rows:
            t = Table(rows, colWidths=[4.4 * inch, 2.6 * inch])
            t.setStyle(_table_style(len(rows)))
            story.append(t)
            story.append(Spacer(1, 10))

    for c in concepts:
        letter = letter_of(c)
        if letter != current_letter:
            flush()
            rows = []
            current_letter = letter
            story.append(Paragraph(letter, styles["letter"]))

        c_entries = [e for e in entries if e.get("concept") == c]
        direct = [e for e in c_entries if not (e.get("subconcept") or "").strip()]
        if direct:
            refs = ", ".join(filter(None, (ref_string(e.get("book"), e.get("page")) for e in direct))) or "—"
            rows.append([Paragraph(_esc(c), styles["cell"]), Paragraph(_esc(refs), styles["cell_ref"])])

        subs = _ordered_subconcepts(c_entries)
        for s in subs:
            refs = ", ".join(
                filter(None, (
                    ref_string(e.get("book"), e.get("page"))
                    for e in c_entries
                    if (e.get("subconcept") or "").strip() == s
                ))
            ) or "—"
            term = s if direct else f"{c} — {s}"
            rows.append([Paragraph(_esc(term), styles["cell_sub"]), Paragraph(_esc(refs), styles["cell_ref"])])

    flush()
    return story


def generate_pdf(entries):
    entries = sorted_for_pdf(entries)
    styles = _build_styles()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.6 * inch,
        bottomMargin=0.6 * inch,
        title="GXPN Study Index",
    )

    story = _build_full_story(entries, styles)
    story.append(PageBreak())
    story += _build_simple_story(entries, styles)

    doc.build(story)
    return buf.getvalue()
