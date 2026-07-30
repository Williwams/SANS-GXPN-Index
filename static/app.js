(() => {
  "use strict";

  let entries = [];
  let meta = { concepts: [], subconceptsByConcept: {}, books: [] };
  let sources = [];
  let editingId = null;
  let pendingDuplicate = null; // {payload, existing}
  let activeTab = "table";

  const $ = (id) => document.getElementById(id);
  const form = $("entry-form");
  const conceptInput = $("concept");
  const subconceptInput = $("subconcept");
  const bookInput = $("book");
  const pageInput = $("page");
  const notesInput = $("notes");
  const idInput = $("entry-id");
  const submitBtn = $("submit-btn");
  const cancelEditBtn = $("cancel-edit-btn");
  const dupWarning = $("dup-warning");
  const searchInput = $("search");
  const existingList = $("existing-list");
  const formTitle = $("form-title");

  // ---------- fuzzy matching (bigram Dice coefficient, typo-tolerant) ----------
  function bigrams(s) {
    s = s.toLowerCase();
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  }
  function diceCoefficient(a, b) {
    if (!a || !b) return 0;
    const bA = bigrams(a), bB = bigrams(b);
    if (!bA.length || !bB.length) return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
    const map = new Map();
    for (const bg of bA) map.set(bg, (map.get(bg) || 0) + 1);
    let matches = 0;
    for (const bg of bB) {
      const c = map.get(bg) || 0;
      if (c > 0) { matches++; map.set(bg, c - 1); }
    }
    return (2 * matches) / (bA.length + bB.length);
  }

  function rankSuggestions(query, items, getName, showAllIfEmpty) {
    const q = query.trim().toLowerCase();
    if (!q) {
      if (!showAllIfEmpty) return [];
      return items
        .map((item) => ({ item, name: getName(item), score: 0, exact: true }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20);
    }
    const scored = items.map((item) => {
      const name = getName(item);
      const lower = name.toLowerCase();
      let score, exact = false;
      if (lower === q) { score = 2; exact = true; }
      else if (lower.startsWith(q)) { score = 1.5; exact = true; }
      else if (lower.includes(q)) { score = 1.2; exact = true; }
      else { score = diceCoefficient(q, lower); }
      return { item, name, score, exact };
    });
    return scored
      .filter((s) => s.exact || s.score >= 0.32)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  // ---------- autocomplete wiring ----------
  function wireAutocomplete(input, listEl, getItems, onPick, opts = {}) {
    const showAllIfEmpty = !!opts.showAllIfEmpty;
    const open = () => {
      const items = getItems();
      const ranked = rankSuggestions(input.value, items.list, items.getName, showAllIfEmpty);
      renderSuggestions(listEl, ranked, items.getMeta, onPick);
    };
    input.addEventListener("input", open);
    input.addEventListener("focus", open);
    if (showAllIfEmpty) {
      // clicking an already-focused, empty combobox should reopen the full list too
      input.addEventListener("click", open);
    }
    document.addEventListener("click", (e) => {
      if (!listEl.contains(e.target) && e.target !== input) {
        listEl.classList.remove("open");
      }
    });
  }

  function renderSuggestions(listEl, ranked, getMeta, onPick) {
    listEl.innerHTML = "";
    if (!ranked.length) { listEl.classList.remove("open"); return; }
    for (const r of ranked) {
      const div = document.createElement("div");
      div.className = "ac-item" + (r.exact ? "" : " fuzzy");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const metaSpan = document.createElement("span");
      metaSpan.className = "meta";
      metaSpan.textContent = getMeta(r.item);
      div.appendChild(name);
      div.appendChild(metaSpan);
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onPick(r.name, r.item);
        listEl.classList.remove("open");
      });
      listEl.appendChild(div);
    }
    listEl.classList.add("open");
  }

  function setupAutocompletes() {
    wireAutocomplete(
      conceptInput,
      $("concept-suggestions"),
      () => ({ list: meta.concepts, getName: (c) => c.name, getMeta: (c) => `${c.count} ref${c.count === 1 ? "" : "s"}` }),
      (name) => { conceptInput.value = name; renderExistingForConcept(name); }
    );

    wireAutocomplete(
      subconceptInput,
      $("subconcept-suggestions"),
      () => {
        const c = conceptInput.value.trim();
        const list = (meta.subconceptsByConcept[c] || []);
        return { list, getName: (s) => s, getMeta: () => "" };
      },
      (name) => { subconceptInput.value = name; }
    );

    wireAutocomplete(
      bookInput,
      $("book-suggestions"),
      () => ({ list: sources, getName: (b) => b, getMeta: () => "" }),
      (name) => { bookInput.value = name; validateBook(); },
      { showAllIfEmpty: true }
    );

    // Bulk field: suggest sub-concepts already used by the concepts in the selection
    // (falling back to every sub-concept, e.g. before anything is selected).
    wireAutocomplete(
      $("bulk-subconcept"),
      $("bulk-suggestions"),
      () => {
        const conceptsInSelection = new Set(
          entries.filter((e) => selectedIds.has(e.id)).map((e) => e.concept)
        );
        const pool = conceptsInSelection.size
          ? [...conceptsInSelection].flatMap((c) => meta.subconceptsByConcept[c] || [])
          : Object.values(meta.subconceptsByConcept).flat();
        return { list: [...new Set(pool)].sort((a, b) => a.localeCompare(b)), getName: (s) => s, getMeta: () => "" };
      },
      (name) => { $("bulk-subconcept").value = name; },
      { showAllIfEmpty: true }
    );

    conceptInput.addEventListener("input", () => renderExistingForConcept(conceptInput.value));
  }

  function renderExistingForConcept(conceptRaw) {
    const concept = conceptRaw.trim();
    if (!concept) {
      existingList.className = "existing-list muted";
      existingList.textContent = "Start typing a concept above.";
      return;
    }
    const matches = entries.filter((e) => e.concept.toLowerCase() === concept.toLowerCase());
    if (!matches.length) {
      existingList.className = "existing-list muted";
      existingList.textContent = "No existing entries for this exact concept name yet — check the suggestions above for similar ones.";
      return;
    }
    existingList.className = "existing-list";
    existingList.innerHTML = "";
    for (const e of matches) {
      const div = document.createElement("div");
      div.className = "existing-item";
      const ref = refString(e);
      div.innerHTML = `
        <div class="ref">${escapeHtml(ref || "—")}</div>
        ${e.subconcept ? `<div class="sub">${escapeHtml(e.subconcept)}</div>` : ""}
        <div class="note">${escapeHtml(e.notes || "")}</div>
      `;
      existingList.appendChild(div);
    }
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- data loading ----------
  async function loadAll() {
    const [entriesRes, metaRes, sourcesRes] = await Promise.all([
      fetch("/api/entries"), fetch("/api/meta"), fetch("/api/sources"),
    ]);
    entries = await entriesRes.json();
    meta = await metaRes.json();
    sources = (await sourcesRes.json()).sources || [];
    // Drop selections and open panels whose entries no longer exist (deleted, cleared, ...)
    const liveIds = new Set(entries.map((e) => e.id));
    for (const id of [...selectedIds]) if (!liveIds.has(id)) selectedIds.delete(id);
    for (const id of [...expandedRows]) if (!liveIds.has(id)) expandedRows.delete(id);
    rebuildSiblingIndex();
    renderTable();
    renderStats();
    renderSourcesList();
    updateBookRequirement();
    renderExistingForConcept(conceptInput.value);
    if (activeTab === "markdown") await loadMarkdown();
    if (activeTab === "printable") await renderPrintable();
  }

  // ---------- sources (Book/Source list) ----------
  const manageSourcesBtn = $("manage-sources-btn");
  const sourcesManagerEl = $("sources-manager");
  const sourcesListEl = $("sources-list");
  const newSourceInput = $("new-source-input");
  const bookError = $("book-error");
  const bookReq = $("book-req");

  manageSourcesBtn.addEventListener("click", () => {
    sourcesManagerEl.classList.toggle("hidden");
    if (!sourcesManagerEl.classList.contains("hidden")) newSourceInput.focus();
  });

  function renderSourcesList() {
    sourcesListEl.innerHTML = "";
    for (const s of sources) {
      const chip = document.createElement("div");
      chip.className = "source-chip";
      chip.innerHTML = `<span>${escapeHtml(s)}</span>`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.title = `Remove "${s}"`;
      removeBtn.addEventListener("click", () => removeSource(s));
      chip.appendChild(removeBtn);
      sourcesListEl.appendChild(chip);
    }
  }

  function updateBookRequirement() {
    bookReq.classList.toggle("hidden", sources.length === 0);
  }

  async function saveSources(list) {
    const res = await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: list }),
    });
    const data = await res.json();
    sources = data.sources || [];
    renderSourcesList();
    updateBookRequirement();
  }

  function addSource() {
    const val = newSourceInput.value.trim();
    if (!val) return;
    if (sources.some((s) => s.toLowerCase() === val.toLowerCase())) {
      newSourceInput.value = "";
      return;
    }
    saveSources([...sources, val]);
    newSourceInput.value = "";
    newSourceInput.focus();
  }

  function removeSource(name) {
    if (!confirm(`Remove "${name}" from your source list?\n\nExisting entries already using it keep their value — this only affects future entries.`)) return;
    saveSources(sources.filter((s) => s.toLowerCase() !== name.toLowerCase()));
  }

  $("add-source-btn").addEventListener("click", addSource);
  newSourceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addSource(); }
  });

  function validateBook() {
    if (sources.length === 0) {
      bookInput.classList.remove("invalid");
      bookError.classList.add("hidden");
      return true;
    }
    const val = bookInput.value.trim();
    const match = sources.find((s) => s.toLowerCase() === val.toLowerCase());
    if (!match) {
      bookInput.classList.add("invalid");
      bookError.textContent = val
        ? `"${val}" isn't in your source list — pick one, or add it via "manage list".`
        : "Pick a Book/Source from your list.";
      bookError.classList.remove("hidden");
      return false;
    }
    bookInput.value = match;
    bookInput.classList.remove("invalid");
    bookError.classList.add("hidden");
    return true;
  }

  bookInput.addEventListener("blur", () => {
    // let a suggestion click register before validating
    setTimeout(validateBook, 150);
  });

  // ---------- tabs ----------
  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $("tab-table").classList.toggle("hidden", tab !== "table");
    $("tab-markdown").classList.toggle("hidden", tab !== "markdown");
    $("tab-printable").classList.toggle("hidden", tab !== "printable");
    searchInput.classList.toggle("hidden", tab !== "table");
    if (tab === "markdown") loadMarkdown();
    if (tab === "printable") renderPrintable();
  }

  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // ---------- printable view ----------
  let printSubView = "full";

  document.querySelectorAll(".tab-btn[data-printview]").forEach((btn) => {
    btn.addEventListener("click", () => {
      printSubView = btn.dataset.printview;
      document.querySelectorAll(".tab-btn[data-printview]").forEach((b) =>
        b.classList.toggle("active", b.dataset.printview === printSubView)
      );
      renderPrintable();
    });
  });

  $("print-btn").addEventListener("click", () => window.print());

  $("download-pdf-btn").addEventListener("click", async () => {
    const btn = $("download-pdf-btn");
    const original = btn.textContent;
    btn.textContent = "Generating…";
    btn.disabled = true;
    try {
      const res = await fetch("/api/pdf");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Something went wrong generating the PDF.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gxpn-study-index.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  });

  function refString(e) {
    const book = (e.book || "").trim();
    const page = (e.page || "").trim();
    if (book && page) return `${book}:${page}`;
    if (book) return book;
    if (page) return `p.${page}`;
    return "";
  }

  function letterOf(concept) {
    const c = (concept.trim()[0] || "#").toUpperCase();
    return /[A-Z]/.test(c) ? c : "#";
  }

  function buildSimpleIndexHtml(list) {
    const concepts = [];
    const seen = new Set();
    for (const e of list) {
      if (!seen.has(e.concept)) { seen.add(e.concept); concepts.push(e.concept); }
    }
    if (!concepts.length) return `<p class="muted">Nothing indexed yet.</p>`;

    let html = "";
    let currentLetter = null;
    for (const c of concepts) {
      const letter = letterOf(c);
      if (letter !== currentLetter) {
        if (currentLetter !== null) html += `</tbody></table></div>`;
        currentLetter = letter;
        html += `<div class="letter-group">`;
        html += `<h3 class="letter-heading">${escapeHtml(letter)}</h3>`;
        html += `<table class="index-table"><tbody>`;
      }

      const cEntries = list.filter((e) => e.concept === c);
      const direct = cEntries.filter((e) => !e.subconcept.trim());
      if (direct.length) {
        const refs = direct.map(refString).filter(Boolean);
        html += `<tr><td>${escapeHtml(c)}</td><td>${escapeHtml(refs.join(", ") || "—")}</td></tr>`;
      }

      const subs = [];
      const seenSub = new Set();
      for (const e of cEntries) {
        const s = e.subconcept.trim();
        if (s && !seenSub.has(s)) { seenSub.add(s); subs.push(s); }
      }
      for (const s of subs) {
        const refs = cEntries.filter((e) => e.subconcept.trim() === s).map(refString).filter(Boolean);
        const term = direct.length > 0 ? s : `${c} — ${s}`;
        html += `<tr class="sub-row"><td>${escapeHtml(term)}</td><td>${escapeHtml(refs.join(", ") || "—")}</td></tr>`;
      }
    }
    html += `</tbody></table></div>`;
    return html;
  }

  async function renderPrintable() {
    const target = $("printable-content");
    if (printSubView === "simple") {
      target.className = "printable-area simple-index";
      target.innerHTML = buildSimpleIndexHtml(sorted(entries));
    } else {
      target.className = "printable-area markdown-render";
      const res = await fetch("/api/markdown");
      const data = await res.json();
      target.innerHTML = renderMarkdown(data.markdown || "_Nothing indexed yet._");
    }
  }

  function sorted(list) {
    return [...list].sort((a, b) => {
      const ac = a.concept.toLowerCase(), bc = b.concept.toLowerCase();
      if (ac !== bc) return ac < bc ? -1 : 1;
      const as = a.subconcept.toLowerCase(), bs = b.subconcept.toLowerCase();
      if (as !== bs) return as < bs ? -1 : 1;
      return 0;
    });
  }

  // ---------- markdown rendering (tailored to our own generated INDEX.md) ----------
  function mdSlugify(text) {
    return (
      text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-") || "section"
    );
  }

  function mdInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return out;
  }

  function renderMarkdown(md) {
    const lines = md.split("\n");
    let html = "";
    let inList = false;
    let inToc = false;

    const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };

    for (const raw of lines) {
      const line = raw;
      if (/^\s*-\s+/.test(line)) {
        if (!inList) { html += `<ul${inToc ? ' class="toc-list"' : ""}>`; inList = true; }
        html += `<li>${mdInline(line.replace(/^\s*-\s+/, ""))}</li>`;
        continue;
      }
      closeList();
      if (line.startsWith("### ")) {
        const text = line.slice(4);
        html += `<h3 id="${mdSlugify(text)}">${mdInline(text)}</h3>`;
      } else if (line.startsWith("## ")) {
        const text = line.slice(3);
        inToc = text.trim() === "Table of Contents";
        html += `<h2 id="${mdSlugify(text)}">${mdInline(text)}</h2>`;
      } else if (line.startsWith("# ")) {
        const text = line.slice(2);
        html += `<h1>${mdInline(text)}</h1>`;
      } else if (line.trim() === "") {
        // paragraph break, no output needed
      } else {
        html += `<p>${mdInline(line)}</p>`;
      }
    }
    closeList();
    return html;
  }

  async function loadMarkdown() {
    const res = await fetch("/api/markdown");
    const data = await res.json();
    $("markdown-render").innerHTML = renderMarkdown(data.markdown || "_Nothing indexed yet._");
  }

  // A reference counts as annotated once it carries a note or a sub-concept — the
  // two things an imported page number doesn't come with.
  function isAnnotated(e) {
    return !!((e.subconcept || "").trim() || (e.notes || "").trim());
  }

  function pct(done, total) {
    return total ? Math.round((done / total) * 100) : 0;
  }

  function renderStats() {
    const total = entries.length;
    $("stats").textContent = `${total} entries · ${meta.concepts.length} concepts`;

    const done = entries.filter(isAnnotated).length;
    const concepts = new Set(entries.map((e) => e.concept));
    const started = new Set(entries.filter(isAnnotated).map((e) => e.concept));
    const entryPct = pct(done, total);
    const conceptPct = pct(started.size, concepts.size);

    $("progress-entries").textContent = `${entryPct}% of references annotated (${done}/${total})`;
    $("progress-concepts").textContent = `${conceptPct}% of concepts started (${started.size}/${concepts.size})`;
    // Label rounds, the bar doesn't: with ~1000 references a handful of annotations
    // wouldn't move a rounded width at all, and the point is seeing it creep up.
    // Floor it so the first annotation is visible, but keep a true zero empty.
    const exact = total ? (done / total) * 100 : 0;
    $("progress-fill").style.width = done ? `${Math.max(exact, 0.5).toFixed(2)}%` : "0%";
    const track = $("progress-track");
    track.setAttribute("aria-valuenow", String(entryPct));
    track.title =
      `${done} of ${total} references have a note or sub-concept\n` +
      `${started.size} of ${concepts.size} concepts have at least one annotated reference`;
  }

  // ---------- table sorting ----------
  // Columns the user hasn't explicitly picked still break ties, in this order, so
  // sorting by Book alone reads as book-then-page (i.e. reading order through a book)
  // and the default single "Concept" key reproduces the server's own ordering.
  const TIEBREAK = ["book", "page", "concept", "subconcept"];
  const COL_LABELS = {
    concept: "Concept", subconcept: "Sub-concept", book: "Book", page: "Page", notes: "Notes",
  };
  const DEFAULT_SORT = [{ key: "concept", dir: 1 }];
  let sortKeys = DEFAULT_SORT.map((s) => ({ ...s }));

  function cmpText(a, b) {
    const la = (a || "").toLowerCase(), lb = (b || "").toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  }

  // Same rule as natural_sort_key() in server.py: leading numbers sort numerically
  // and ahead of non-numeric values, so 9 < 10 and "141-142" sits after "129".
  function cmpNatural(a, b) {
    const ma = /^\s*(\d+)/.exec(a || ""), mb = /^\s*(\d+)/.exec(b || "");
    if (ma && mb) {
      const diff = parseInt(ma[1], 10) - parseInt(mb[1], 10);
      return diff !== 0 ? diff : cmpText(a, b);
    }
    if (ma) return -1;
    if (mb) return 1;
    return cmpText(a, b);
  }

  function effectiveSortKeys() {
    const used = new Set(sortKeys.map((s) => s.key));
    return [...sortKeys, ...TIEBREAK.filter((k) => !used.has(k)).map((k) => ({ key: k, dir: 1 }))];
  }

  function sortForTable(list) {
    const keys = effectiveSortKeys();
    return [...list].sort((a, b) => {
      for (const { key, dir } of keys) {
        const isNumericish = key === "book" || key === "page";
        const c = isNumericish ? cmpNatural(a[key], b[key]) : cmpText(a[key], b[key]);
        if (c !== 0) return c * dir;
      }
      return 0;
    });
  }

  function isDefaultSort() {
    return (
      sortKeys.length === DEFAULT_SORT.length &&
      sortKeys.every((s, i) => s.key === DEFAULT_SORT[i].key && s.dir === DEFAULT_SORT[i].dir)
    );
  }

  function toggleSort(key, additive) {
    const existing = sortKeys.find((s) => s.key === key);
    if (additive) {
      if (existing) existing.dir *= -1;
      else sortKeys.push({ key, dir: 1 });
    } else if (existing && sortKeys.length === 1) {
      existing.dir *= -1;
    } else {
      sortKeys = [{ key, dir: 1 }];
    }
    renderTable();
  }

  function renderSortUI() {
    for (const th of document.querySelectorAll("th.sortable")) {
      const idx = sortKeys.findIndex((s) => s.key === th.dataset.sort);
      const ind = th.querySelector(".sort-ind");
      th.classList.toggle("sorted", idx >= 0);
      if (idx < 0) {
        ind.textContent = "";
        th.removeAttribute("aria-sort");
        continue;
      }
      const asc = sortKeys[idx].dir > 0;
      ind.textContent = (asc ? "▲" : "▼") + (sortKeys.length > 1 ? String(idx + 1) : "");
      th.setAttribute("aria-sort", asc ? "ascending" : "descending");
    }
    const chain = sortKeys.map((s) => `${COL_LABELS[s.key]} ${s.dir > 0 ? "↑" : "↓"}`).join(" → ");
    $("sort-status").innerHTML =
      `Sorted by <strong>${escapeHtml(chain)}</strong>` +
      ` <span class="muted">· shift-click a header to sort by more than one column</span>` +
      (isDefaultSort() ? "" : ` <button type="button" class="link-btn" data-action="reset-sort">reset</button>`);
  }

  document.querySelector("#entries-table thead").addEventListener("click", (ev) => {
    const th = ev.target.closest("th.sortable");
    if (!th) return;
    toggleSort(th.dataset.sort, ev.shiftKey);
  });

  $("sort-status").addEventListener("click", (ev) => {
    if (!ev.target.closest('[data-action="reset-sort"]')) return;
    sortKeys = DEFAULT_SORT.map((s) => ({ ...s }));
    renderTable();
  });

  // ---------- table ----------
  let visible = [];      // filtered + sorted: every entry the filter admits
  let renderedIds = [];  // main entry rows on screen, in order (for shift-click ranges)
  const expandedRows = new Set(); // ids whose "other references" panel is open

  // Every reference for a concept, always book → page regardless of the table's sort,
  // and drawn from all entries rather than the filtered set — the point is to see
  // every place the concept turns up, including ones the current filter hides.
  // Indexed once per load: a row's expander needs the count, so this is hot.
  let siblingIndex = new Map();

  function rebuildSiblingIndex() {
    siblingIndex = new Map();
    for (const e of entries) {
      if (!siblingIndex.has(e.concept)) siblingIndex.set(e.concept, []);
      siblingIndex.get(e.concept).push(e);
    }
    for (const list of siblingIndex.values()) {
      list.sort((a, b) => cmpNatural(a.book, b.book) || cmpNatural(a.page, b.page));
    }
  }

  function siblingsOf(concept) {
    return siblingIndex.get(concept) || [];
  }

  function entryRow(e) {
    const count = siblingsOf(e.concept).length;
    const open = expandedRows.has(e.id);
    const tr = document.createElement("tr");
    if (selectedIds.has(e.id)) tr.className = "row-selected";
    tr.innerHTML = `
      <td class="select-col">
        <input type="checkbox" data-select-id="${e.id}"${selectedIds.has(e.id) ? " checked" : ""}>
      </td>
      <td class="concept-cell">
        <button type="button" class="sib-toggle${open ? " open" : ""}" data-siblings="${e.id}"
                title="Show every reference for this concept, with its sub-concept">
          <span class="caret">${open ? "▾" : "▸"}</span>${count}
        </button>
        ${escapeHtml(e.concept)}
      </td>
      <td>${escapeHtml(e.subconcept)}</td>
      <td>${escapeHtml(e.book)}</td>
      <td>${escapeHtml(e.page)}</td>
      <td class="notes-cell">${escapeHtml(e.notes)}</td>
      <td class="actions-cell">
        <button type="button" class="secondary small" data-action="edit" data-id="${e.id}">Edit</button>
        <button type="button" class="danger small" data-action="delete" data-id="${e.id}">Delete</button>
      </td>
    `;
    return tr;
  }

  function subconceptTally(sibs) {
    const counts = new Map();
    let unlabelled = 0;
    for (const s of sibs) {
      const sub = (s.subconcept || "").trim();
      if (!sub) unlabelled++;
      else counts.set(sub, (counts.get(sub) || 0) + 1);
    }
    const parts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || cmpText(a[0], b[0]))
      .map(([sub, n]) => `<span class="sib-chip">${escapeHtml(sub)} <b>${n}</b></span>`);
    if (unlabelled) parts.push(`<span class="sib-chip muted">unlabelled <b>${unlabelled}</b></span>`);
    return parts.join(" ");
  }

  function siblingPanel(e) {
    const sibs = siblingsOf(e.concept);
    const tr = document.createElement("tr");
    tr.className = "sibling-panel";
    tr.dataset.panelFor = e.id;
    const rows = sibs
      .map((s) => {
        const sub = (s.subconcept || "").trim();
        return `
          <tr class="${s.id === e.id ? "is-current" : ""}${selectedIds.has(s.id) ? " row-selected" : ""}">
            <td class="sib-ref">${escapeHtml(refString(s) || "—")}${
              s.id === e.id ? '<span class="sib-here">this row</span>' : ""
            }</td>
            <td class="sib-sub">${sub ? escapeHtml(sub) : '<span class="muted">— no sub-concept</span>'}</td>
            <td class="sib-note">${escapeHtml(s.notes || "")}</td>
            <td class="sib-actions">
              <button type="button" class="secondary small" data-action="edit" data-id="${s.id}">Edit</button>
              <button type="button" class="danger small" data-action="delete" data-id="${s.id}">Exclude</button>
            </td>
          </tr>`;
      })
      .join("");
    tr.innerHTML = `
      <td></td>
      <td colspan="6" class="sib-cell">
        <div class="sib-head">
          <strong>${sibs.length} reference${sibs.length === 1 ? "" : "s"}</strong>
          for ${escapeHtml(e.concept)} <span class="muted">· book → page</span>
          <button type="button" class="link-btn" data-select-concept="${escapeHtml(e.concept)}">select all for labelling</button>
        </div>
        <div class="sib-subs">${subconceptTally(sibs) || '<span class="muted">no sub-concepts yet</span>'}</div>
        <table class="sib-table"><tbody>${rows}</tbody></table>
      </td>
    `;
    return tr;
  }

  function renderTable() {
    const q = searchInput.value.trim().toLowerCase();
    const body = $("entries-body");
    body.innerHTML = "";
    const matchesSearch = (e) =>
      !q ||
      [e.concept, e.subconcept, e.book, e.page, e.notes].some((v) => (v || "").toLowerCase().includes(q));
    const searched = entries.filter(matchesSearch);
    // "Hide annotated" leaves only the work still to do. It deliberately does not
    // reach into the sibling panels — those exist to show what a concept already has.
    const hiding = hideAnnotatedBox.checked;
    const filtered = hiding ? searched.filter((e) => !isAnnotated(e)) : searched;
    renderHideAnnotatedLabel(hiding ? searched.length - filtered.length : 0);
    visible = sortForTable(filtered);
    renderedIds = [];
    for (const e of visible) {
      body.appendChild(entryRow(e));
      renderedIds.push(e.id);
      if (expandedRows.has(e.id)) body.appendChild(siblingPanel(e));
    }
    renderSortUI();
    renderSelectionUI();
  }

  $("entries-body").addEventListener("click", (e) => {
    const box = e.target.closest("input[data-select-id]");
    if (box) {
      handleRowCheckbox(box.dataset.selectId, box.checked, e.shiftKey);
      return;
    }
    const sib = e.target.closest("button[data-siblings]");
    if (sib) {
      const id = sib.dataset.siblings;
      if (expandedRows.has(id)) expandedRows.delete(id);
      else expandedRows.add(id);
      renderTable();
      return;
    }
    const selectConcept = e.target.closest("[data-select-concept]");
    if (selectConcept) {
      for (const s of siblingsOf(selectConcept.dataset.selectConcept)) selectedIds.add(s.id);
      lastToggledId = null;
      renderTable();
      return;
    }
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "edit") startEdit(id);
    else if (btn.dataset.action === "delete") deleteEntry(id);
  });

  $("collapse-panels-btn").addEventListener("click", () => {
    expandedRows.clear();
    renderTable();
  });

  // ---------- hide-what's-done filter ----------
  const hideAnnotatedBox = $("hide-annotated");

  function renderHideAnnotatedLabel(hidden) {
    $("hide-annotated-label").textContent = hidden
      ? `Hide annotated (${hidden} hidden)`
      : "Hide annotated";
  }

  hideAnnotatedBox.addEventListener("change", renderTable);

  // ---------- bulk sub-concept assignment ----------
  const selectedIds = new Set();
  let lastToggledId = null;
  const bulkBar = $("bulk-bar");
  const bulkInput = $("bulk-subconcept");
  const selectAllBox = $("select-all");

  function handleRowCheckbox(id, checked, shiftKey) {
    // Shift-click paints the whole run since the last click — the point of the
    // feature, when a block of consecutive pages shares one sub-concept.
    let ids = [id];
    if (shiftKey && lastToggledId && lastToggledId !== id) {
      // Range walks the rows actually on screen, so a collapsed group is never
      // caught in a shift-click the user can't see.
      const from = renderedIds.indexOf(lastToggledId), to = renderedIds.indexOf(id);
      if (from !== -1 && to !== -1) {
        ids = renderedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
      }
    }
    for (const each of ids) {
      if (checked) selectedIds.add(each);
      else selectedIds.delete(each);
    }
    lastToggledId = id;
    renderTable();
  }

  selectAllBox.addEventListener("change", () => {
    for (const e of visible) {
      if (selectAllBox.checked) selectedIds.add(e.id);
      else selectedIds.delete(e.id);
    }
    lastToggledId = null;
    renderTable();
  });

  function renderSelectionUI() {
    const openPanels = expandedRows.size;
    $("collapse-panels-btn").classList.toggle("hidden", openPanels === 0);
    $("collapse-panels-btn").textContent = `collapse ${openPanels} open list${openPanels === 1 ? "" : "s"}`;
    const n = selectedIds.size;
    bulkBar.classList.toggle("hidden", n === 0);
    $("bulk-count").textContent = `${n} selected`;
    const shown = visible.length;
    const shownSelected = visible.filter((e) => selectedIds.has(e.id)).length;
    selectAllBox.checked = shown > 0 && shownSelected === shown;
    selectAllBox.indeterminate = shownSelected > 0 && shownSelected < shown;
  }

  function clearSelection() {
    selectedIds.clear();
    lastToggledId = null;
    bulkInput.value = "";
    renderTable();
  }

  $("bulk-cancel-btn").addEventListener("click", clearSelection);

  $("bulk-apply-btn").addEventListener("click", async () => {
    if (!selectedIds.size) return;
    const subconcept = bulkInput.value.trim();
    const ids = [...selectedIds];
    if (!subconcept && !confirm(`Remove the sub-concept from ${ids.length} selected entr${ids.length === 1 ? "y" : "ies"}?`)) {
      return;
    }
    const res = await fetch("/api/entries/subconcept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, subconcept }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Something went wrong updating the selected entries.");
      return;
    }
    clearSelection();
    await loadAll();
  });

  function startEdit(id) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    editingId = id;
    idInput.value = id;
    conceptInput.value = entry.concept;
    subconceptInput.value = entry.subconcept;
    bookInput.value = entry.book;
    pageInput.value = entry.page;
    notesInput.value = entry.notes;
    formTitle.textContent = "Edit entry";
    submitBtn.textContent = "Save changes";
    cancelEditBtn.classList.remove("hidden");
    hideDupWarning();
    bookInput.classList.remove("invalid");
    bookError.classList.add("hidden");
    renderExistingForConcept(entry.concept);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  cancelEditBtn.addEventListener("click", () => resetForm());

  function resetForm() {
    editingId = null;
    pendingDuplicate = null;
    idInput.value = "";
    form.reset();
    formTitle.textContent = "Add entry";
    submitBtn.textContent = "Add entry";
    cancelEditBtn.classList.add("hidden");
    hideDupWarning();
    bookInput.classList.remove("invalid");
    bookError.classList.add("hidden");
    renderExistingForConcept("");
  }

  async function deleteEntry(id) {
    const entry = entries.find((e) => e.id === id);
    // Name the reference, not just the concept: deletions also come from the
    // sibling panel, where every row shares the same concept.
    const ref = entry ? refString(entry) : "";
    const label = entry
      ? `"${entry.concept}"${entry.subconcept ? " / " + entry.subconcept : ""}${ref ? ` at ${ref}` : ""}`
      : "this entry";
    if (!confirm(`Delete ${label}?`)) return;
    const res = await fetch(`/api/entries/${id}`, { method: "DELETE" });
    if (res.ok) {
      if (editingId === id) resetForm();
      await loadAll();
    }
  }

  // ---------- form submit ----------
  function currentPayload() {
    return {
      concept: conceptInput.value.trim(),
      subconcept: subconceptInput.value.trim(),
      book: bookInput.value.trim(),
      page: pageInput.value.trim(),
      notes: notesInput.value.trim(),
    };
  }

  function hideDupWarning() {
    dupWarning.classList.add("hidden");
    dupWarning.innerHTML = "";
    pendingDuplicate = null;
  }

  function showDupWarning(existing, payload) {
    pendingDuplicate = payload;
    const ref = refString(existing);
    dupWarning.innerHTML = `
      An identical reference already exists for <strong>${escapeHtml(existing.concept)}</strong>
      ${existing.subconcept ? `/ ${escapeHtml(existing.subconcept)}` : ""}
      (${escapeHtml(ref || "no book/page")}):<br>
      <em>${escapeHtml(existing.notes || "(no notes)")}</em>
      <div>
        <button type="button" id="dup-add-anyway">Add anyway</button>
        <button type="button" id="dup-cancel" class="secondary">Cancel</button>
      </div>
    `;
    dupWarning.classList.remove("hidden");
    $("dup-add-anyway").addEventListener("click", () => submitEntry(payload, true));
    $("dup-cancel").addEventListener("click", hideDupWarning);
  }

  async function submitEntry(payload, force) {
    const body = { ...payload, force };
    let res, url, method;
    if (editingId) {
      url = `/api/entries/${editingId}`;
      method = "PUT";
    } else {
      url = "/api/entries";
      method = "POST";
    }
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const data = await res.json();
      showDupWarning(data.existing, payload);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Something went wrong saving this entry.");
      return;
    }
    hideDupWarning();
    resetForm();
    await loadAll();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validateBook()) { bookInput.focus(); return; }
    const payload = currentPayload();
    if (!payload.concept) return;
    submitEntry(payload, false);
  });

  searchInput.addEventListener("input", renderTable);

  // ---------- clear all ----------
  const CLEAR_PHRASE = "CLEAR ALL";
  const clearAllBtn = $("clear-all-btn");
  const clearAllConfirm = $("clear-all-confirm");
  const clearAllInput = $("clear-all-input");
  const clearAllConfirmBtn = $("clear-all-confirm-btn");
  const clearAllCancelBtn = $("clear-all-cancel-btn");

  clearAllBtn.addEventListener("click", () => {
    clearAllConfirm.classList.remove("hidden");
    clearAllInput.value = "";
    clearAllConfirmBtn.disabled = true;
    clearAllInput.focus();
  });

  clearAllCancelBtn.addEventListener("click", () => {
    clearAllConfirm.classList.add("hidden");
    clearAllInput.value = "";
  });

  clearAllInput.addEventListener("input", () => {
    clearAllConfirmBtn.disabled = clearAllInput.value.trim().toUpperCase() !== CLEAR_PHRASE;
  });

  clearAllConfirmBtn.addEventListener("click", async () => {
    if (clearAllInput.value.trim().toUpperCase() !== CLEAR_PHRASE) return;
    const res = await fetch("/api/entries", { method: "DELETE" });
    if (res.ok) {
      clearAllConfirm.classList.add("hidden");
      clearAllInput.value = "";
      resetForm();
      await loadAll();
    } else {
      alert("Something went wrong clearing entries.");
    }
  });

  setupAutocompletes();
  loadAll();
})();
