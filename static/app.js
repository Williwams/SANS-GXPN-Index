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

  function renderStats() {
    $("stats").textContent = `${entries.length} entries · ${meta.concepts.length} concepts`;
  }

  // ---------- table ----------
  function renderTable() {
    const q = searchInput.value.trim().toLowerCase();
    const body = $("entries-body");
    body.innerHTML = "";
    const filtered = entries.filter((e) => {
      if (!q) return true;
      return [e.concept, e.subconcept, e.book, e.page, e.notes]
        .some((v) => (v || "").toLowerCase().includes(q));
    });
    for (const e of filtered) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(e.concept)}</td>
        <td>${escapeHtml(e.subconcept)}</td>
        <td>${escapeHtml(e.book)}</td>
        <td>${escapeHtml(e.page)}</td>
        <td class="notes-cell">${escapeHtml(e.notes)}</td>
        <td class="actions-cell">
          <button type="button" class="secondary small" data-action="edit" data-id="${e.id}">Edit</button>
          <button type="button" class="danger small" data-action="delete" data-id="${e.id}">Delete</button>
        </td>
      `;
      body.appendChild(tr);
    }
  }

  $("entries-body").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "edit") startEdit(id);
    else if (btn.dataset.action === "delete") deleteEntry(id);
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
    const label = entry ? `"${entry.concept}"${entry.subconcept ? " / " + entry.subconcept : ""}` : "this entry";
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
