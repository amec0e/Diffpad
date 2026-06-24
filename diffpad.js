// ── STATE ──
let diffBlocks     = [];
let currentDiffIdx = -1;
let viewMode       = 'split';
let ignoreWS       = false;
let diffRows       = [];   // diffBlock index → div element
let lastOps        = [];
let lastALines     = [];
let lastBLines     = [];
let sidebarOpen    = false;
let worker         = null;
let isComputing    = false;
let outputPanelOpen = false;

// Hunks: groups of consecutive non-eq ops.
// Each hunk: { id (first opIdx), opIndices: [...] }
// mergeOverrides: Map<hunkId, 'left'|'right'>
let hunks          = [];
let mergeOverrides = new Map();
let selectedHunkId = null;  // hunk currently selected in split view

// ── WEB WORKER SETUP ──

function initWorker() {
  if (!window.Worker) return null;
  try {
    const w = new Worker('diffpad.worker.js');
    w.onerror = err => {
      console.warn('DiffPad worker error, falling back to sync:', err);
      worker = null;
    };
    return w;
  } catch (e) { return null; }
}
worker = initWorker();

// ── LOADING OVERLAY ──

function showLoading() {
  document.getElementById('diff-loading').style.display = 'flex';
  document.getElementById('btn-compare').disabled = true;
  document.getElementById('btn-compare').textContent = 'Computing…';
}

function hideLoading() {
  document.getElementById('diff-loading').style.display = 'none';
  document.getElementById('btn-compare').disabled = false;
  document.getElementById('btn-compare').innerHTML = `
    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 4h14v1H1zm0 4h10v1H1zm0 4h12v1H1z"/><path d="M13 6l3 2-3 2V6z"/></svg>
    Compare`;
}

// ── FILE HANDLING ──

function triggerOpen(side) {
  document.getElementById('file-input-' + side).click();
}

function loadFile(e, side) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById(side + '-editor').value = ev.target.result;
    document.getElementById('fname-' + side).textContent = file.name;
    updateLineCount(side);
    e.target.value = '';
  };
  reader.readAsText(file);
}

function onDragOver(e, side) {
  e.preventDefault();
  document.getElementById('pane-' + side).classList.add('drag-over');
}

function onDragLeave(side) {
  document.getElementById('pane-' + side).classList.remove('drag-over');
}

function onDrop(e, side) {
  e.preventDefault();
  document.getElementById('pane-' + side).classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById(side + '-editor').value = ev.target.result;
    document.getElementById('fname-' + side).textContent = file.name;
    updateLineCount(side);
  };
  reader.readAsText(file);
}

// ── UTILITIES ──

function updateLineCount(side) {
  const val = document.getElementById(side + '-editor').value;
  const n = val === '' ? 0 : val.split('\n').length;
  document.getElementById('lc-' + side).textContent = n + ' ln';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── INLINE CHAR DIFF ──

function charDiff(a, b) {
  const MAX = 2000;
  if (a.length > MAX || b.length > MAX) {
    return { aHtml: escHtml(a), bHtml: escHtml(b) };
  }
  const ac = [...a], bc = [...b], m = ac.length, n = bc.length;
  const dp = new Int32Array((m + 1) * (n + 1));
  const W = n + 1;
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i * W + j] = ac[i] === bc[j]
        ? dp[(i + 1) * W + (j + 1)] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
  const ap = [], bp = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && ac[i] === bc[j]) {
      ap.push({ t: 'eq', c: ac[i] }); bp.push({ t: 'eq', c: bc[j] }); i++; j++;
    } else if (j < n && (i >= m || dp[i * W + (j + 1)] >= dp[(i + 1) * W + j])) {
      bp.push({ t: 'ins', c: bc[j] }); j++;
    } else {
      ap.push({ t: 'del', c: ac[i] }); i++;
    }
  }
  function render(parts, cls) {
    let h = '', inSpan = false;
    for (const p of parts) {
      if (p.t === cls) { if (!inSpan) { h += `<span class="inline-${cls}">`; inSpan = true; } }
      else             { if (inSpan)  { h += '</span>'; inSpan = false; } }
      h += escHtml(p.c);
    }
    if (inSpan) h += '</span>';
    return h;
  }
  return { aHtml: render(ap, 'del'), bHtml: render(bp, 'ins') };
}

// ── SYNCHRONOUS FALLBACK DIFF (no worker) ──

function syncDiff(aLines, bLines) {
  if (aLines.join('\n') === bLines.join('\n')) {
    return aLines.map((text, i) => ({ type: 'eq', aIdx: i, bIdx: i, text }));
  }
  const norm = l => ignoreWS ? l.replace(/\s+/g, ' ').trim() : l;
  const aN = aLines.map(norm), bN = bLines.map(norm);
  let pre = 0;
  const minL = Math.min(aN.length, bN.length);
  while (pre < minL && aN[pre] === bN[pre]) pre++;
  let suf = 0;
  const maxS = Math.min(aN.length - pre, bN.length - pre);
  while (suf < maxS && aN[aN.length - 1 - suf] === bN[bN.length - 1 - suf]) suf++;
  const aMid = aLines.slice(pre, aLines.length - suf || undefined);
  const bMid = bLines.slice(pre, bLines.length - suf || undefined);
  const aMN = aN.slice(pre, aN.length - suf || undefined);
  const bMN = bN.slice(pre, bN.length - suf || undefined);
  const m = aMN.length, n = bMN.length, W = n + 1;
  const dp = new Int32Array((m + 1) * W);
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i * W + j] = aMN[i] === bMN[j]
        ? dp[(i + 1) * W + (j + 1)] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
  const mid = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aMN[i] === bMN[j]) {
      mid.push({ type: 'eq', aIdx: pre + i, bIdx: pre + j, text: aMid[i] }); i++; j++;
    } else if (j < n && (i >= m || dp[i * W + (j + 1)] >= dp[(i + 1) * W + j])) {
      mid.push({ type: 'ins', bIdx: pre + j, text: bMid[j] }); j++;
    } else {
      mid.push({ type: 'del', aIdx: pre + i, text: aMid[i] }); i++;
    }
  }
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push({ type: 'eq', aIdx: k, bIdx: k, text: aLines[k] });
  ops.push(...mid);
  for (let k = 0; k < suf; k++) {
    const aI = aLines.length - suf + k;
    ops.push({ type: 'eq', aIdx: aI, bIdx: bLines.length - suf + k, text: aLines[aI] });
  }
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'del' && k + 1 < ops.length && ops[k + 1].type === 'ins') {
      out.push({ type: 'mod', aIdx: ops[k].aIdx, bIdx: ops[k + 1].bIdx, aText: ops[k].text, bText: ops[k + 1].text });
      k += 2;
    } else { out.push(ops[k]); k++; }
  }
  return out;
}

// ── RUN DIFF ──

function runDiff() {
  if (isComputing) return;
  const lv = document.getElementById('left-editor').value;
  const rv = document.getElementById('right-editor').value;
  const aLines = lv === '' ? [] : lv.split('\n');
  const bLines = rv === '' ? [] : rv.split('\n');
  showLoading();
  isComputing = true;
  mergeOverrides = new Map();
  selectedHunkId = null;

  if (worker) {
    worker.onmessage = e => {
      isComputing = false;
      hideLoading();
      applyDiffResult(e.data.ops, e.data.adds, e.data.dels, e.data.mods, aLines, bLines);
    };
    worker.postMessage({ aLines, bLines, ignoreWS });
  } else {
    setTimeout(() => {
      const ops = syncDiff(aLines, bLines);
      let adds = 0, dels = 0, mods = 0;
      for (const op of ops) {
        if (op.type === 'ins') adds++;
        else if (op.type === 'del') dels++;
        else if (op.type === 'mod') mods++;
      }
      isComputing = false;
      hideLoading();
      applyDiffResult(ops, adds, dels, mods, aLines, bLines);
    }, 30);
  }
}

// ── BUILD HUNKS ──
// Group consecutive non-eq ops into hunks.
// Each hunk gets a stable id = index of its first op in lastOps.

function buildHunks(ops) {
  const result = [];
  let current = null;
  ops.forEach((op, idx) => {
    if (op.type === 'eq') {
      if (current) { result.push(current); current = null; }
    } else {
      if (!current) current = { id: idx, opIndices: [] };
      current.opIndices.push(idx);
    }
  });
  if (current) result.push(current);
  return result;
}

// ── APPLY RESULTS ──

function applyDiffResult(ops, adds, dels, mods, aLines, bLines) {
  lastOps = ops;
  lastALines = aLines;
  lastBLines = bLines;
  hunks = buildHunks(ops);
  diffBlocks = [];
  ops.forEach((op, idx) => {
    if (op.type !== 'eq') diffBlocks.push({ op, idx, type: op.type });
  });

  document.getElementById('stat-add').textContent = adds;
  document.getElementById('stat-del').textContent = dels;
  document.getElementById('stat-mod').textContent = mods;
  document.getElementById('change-count').textContent = diffBlocks.length;
  document.getElementById('sheet-count').textContent = diffBlocks.length;

  document.getElementById('output-fname-left').textContent = document.getElementById('fname-left').textContent;
  document.getElementById('output-fname-right').textContent = document.getElementById('fname-right').textContent;

  renderNav(ops);
  renderSheet(ops);

  document.getElementById('input-view').classList.add('hidden');
  document.getElementById('diff-view').classList.add('visible');
  document.getElementById('btn-compare').classList.add('active');
  document.getElementById('status-view-mode').style.display = '';

  requestAnimationFrame(() => {
    if (viewMode === 'split') renderSplitView(ops);
    else renderUnifiedView(ops);

    if (diffBlocks.length > 0) {
      document.getElementById('jump-nav').style.display = 'flex';
      currentDiffIdx = -1;
      jumpDiff(1);
    } else {
      document.getElementById('jump-nav').style.display = 'none';
      document.getElementById('jump-indicator').textContent = 'Files identical';
    }

    document.getElementById('status-text').textContent =
      `${diffBlocks.length} change${diffBlocks.length !== 1 ? 's' : ''} · ${aLines.length}→${bLines.length} lines`;

    if (outputPanelOpen) renderOutputPanels();
  });
}

// ── SIDEBAR NAV ──

function renderNav(ops) {
  const nav = document.getElementById('diff-nav');
  nav.innerHTML = '';
  diffBlocks.forEach((block, i) => {
    const op = block.op;
    const li = document.createElement('li');
    li.className = `diff-nav-item type-${op.type}`;
    const lineNum = op.type === 'ins' ? (op.bIdx + 1) : (op.aIdx + 1);
    let preview = (op.type === 'mod' ? op.bText : op.text) || '';
    if (preview.length > 20) preview = preview.slice(0, 20) + '…';
    const badge = op.type === 'ins' ? 'ADD' : op.type === 'del' ? 'DEL' : 'MOD';
    li.innerHTML = `
      <div class="diff-type-bar"></div>
      <div class="diff-nav-content">
        <div class="diff-nav-line">Line ${lineNum}</div>
        <div class="diff-nav-preview">${escHtml(preview) || '&nbsp;'}</div>
      </div>
      <span class="diff-type-badge">${badge}</span>`;
    li.addEventListener('click', () => jumpToBlock(i));
    nav.appendChild(li);
  });
}

// ── MOBILE BOTTOM SHEET ──

function renderSheet(ops) {
  const list = document.getElementById('sheet-list');
  list.innerHTML = '';
  diffBlocks.forEach((block, i) => {
    const op = block.op;
    const div = document.createElement('div');
    div.className = `sheet-item type-${op.type}`;
    const lineNum = op.type === 'ins' ? (op.bIdx + 1) : (op.aIdx + 1);
    let preview = (op.type === 'mod' ? op.bText : op.text) || '';
    if (preview.length > 35) preview = preview.slice(0, 35) + '…';
    const badge = op.type === 'ins' ? 'ADD' : op.type === 'del' ? 'DEL' : 'MOD';
    div.innerHTML = `
      <div class="sheet-item-bar"></div>
      <div class="sheet-item-body">
        <div class="sheet-item-meta"><span>Line ${lineNum}</span></div>
        <div class="sheet-item-preview">${escHtml(preview) || '(empty line)'}</div>
      </div>
      <span class="sheet-badge">${badge}</span>`;
    div.addEventListener('click', () => { jumpToBlock(i); closeSheet(); });
    list.appendChild(div);
  });
}

// ── MERGE BAR (split view only, appears on hunk click) ──

function makeMergeBar(hunkId) {
  const ov = mergeOverrides.get(hunkId);
  const isSelected = selectedHunkId === hunkId;
  const isResolved = ov !== undefined;

  // Bar is visible only when the hunk is selected OR already resolved
  const hidden = (!isSelected && !isResolved) ? ' merge-bar-hidden' : '';
  const resolved = isResolved ? ' merge-bar-resolved' : '';

  const bar = document.createElement('div');
  bar.className = `merge-bar${hidden}${resolved}`;
  bar.dataset.hunkid = hunkId;

  const leftActive  = ov === 'left'  ? ' merge-bar-btn-active merge-bar-left-active'  : '';
  const rightActive = ov === 'right' ? ' merge-bar-btn-active merge-bar-right-active' : '';

  bar.innerHTML =
    `<button class="merge-bar-btn merge-bar-left${leftActive}" onclick="applyMerge(event,${hunkId},'left')">` +
      `<svg viewBox="0 0 12 12" fill="currentColor"><path d="M8 2L4 6l4 4V2z"/></svg>` +
      `Merge Left` +
    `</button>` +
    `<span class="merge-bar-sep"></span>` +
    `<button class="merge-bar-btn merge-bar-right${rightActive}" onclick="applyMerge(event,${hunkId},'right')">` +
      `Merge Right` +
      `<svg viewBox="0 0 12 12" fill="currentColor"><path d="M4 2l4 4-4 4V2z"/></svg>` +
    `</button>`;

  return bar;
}

function selectHunk(hunkId) {
  const prev = selectedHunkId;

  if (prev === hunkId) {
    selectedHunkId = null;
  } else {
    selectedHunkId = hunkId;
  }

  // Deselect previously selected hunk
  if (prev !== null && prev !== hunkId) {
    document.querySelectorAll(`.merge-bar[data-hunkid="${prev}"]`).forEach(bar => {
      if (mergeOverrides.get(prev) === undefined) bar.classList.add('merge-bar-hidden');
    });
    document.querySelectorAll(`.hunk-wrapper[data-hunkid="${prev}"]`).forEach(w => w.classList.remove('hunk-selected'));
  }

  if (selectedHunkId !== null) {
    document.querySelectorAll(`.merge-bar[data-hunkid="${selectedHunkId}"]`).forEach(bar => {
      bar.classList.remove('merge-bar-hidden');
    });
    document.querySelectorAll(`.hunk-wrapper[data-hunkid="${selectedHunkId}"]`).forEach(w => w.classList.add('hunk-selected'));
  } else {
    if (prev !== null && mergeOverrides.get(prev) === undefined) {
      document.querySelectorAll(`.merge-bar[data-hunkid="${prev}"]`).forEach(bar => bar.classList.add('merge-bar-hidden'));
    }
    document.querySelectorAll(`.hunk-wrapper[data-hunkid="${prev}"]`).forEach(w => w.classList.remove('hunk-selected'));
  }
}

function applyMerge(evt, hunkId, side) {
  evt.stopPropagation();
  if (mergeOverrides.get(hunkId) === side) {
    mergeOverrides.delete(hunkId);
  } else {
    mergeOverrides.set(hunkId, side);
  }

  // Re-render the merge bar
  document.querySelectorAll(`.merge-bar[data-hunkid="${hunkId}"]`).forEach(oldBar => {
    const newBar = makeMergeBar(hunkId);
    oldBar.replaceWith(newBar);
  });

  // Update the visible diff rows for this hunk to reflect the merge
  updateHunkRows(hunkId);

  // Also write back to the hidden textareas (keeps them in sync for output panel / re-compare)
  updateEditorPanes();
  if (outputPanelOpen) renderOutputPanels();
}

function updateHunkRows(hunkId) {
  const hunk = hunks.find(h => h.id === hunkId);
  if (!hunk) return;
  const ov = mergeOverrides.get(hunkId);

  const wrapper = document.querySelector(`.hunk-wrapper[data-hunkid="${hunkId}"]`);
  if (!wrapper) return;

  // Clear existing rows inside the wrapper
  wrapper.innerHTML = '';

  if (ov === undefined) {
    // Merge undone — restore original diff rows
    hunk.opIndices.forEach(idx => {
      const op = lastOps[idx];
      if (op.type === 'del') {
        const row = document.createElement('div');
        row.className = 'diff-row diff-row-split row-del hunk-row';
        row.dataset.hunkid = hunkId;
        row.innerHTML =
          `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
          `<span class="dr-cell">${escHtml(op.text) || '&nbsp;'}</span>` +
          `<span class="dr-divider"></span>` +
          `<span class="dr-gutter"></span>` +
          `<span class="dr-cell">&nbsp;</span>`;
        wrapper.appendChild(row);
      } else if (op.type === 'ins') {
        const row = document.createElement('div');
        row.className = 'diff-row diff-row-split row-add hunk-row';
        row.dataset.hunkid = hunkId;
        row.innerHTML =
          `<span class="dr-gutter dr-gutter-left"></span>` +
          `<span class="dr-cell">&nbsp;</span>` +
          `<span class="dr-divider"></span>` +
          `<span class="dr-gutter">${op.bIdx + 1}</span>` +
          `<span class="dr-cell">${escHtml(op.text) || '&nbsp;'}</span>`;
        wrapper.appendChild(row);
      } else if (op.type === 'mod') {
        const cd = charDiff(op.aText, op.bText);
        const delRow = document.createElement('div');
        delRow.className = 'diff-row diff-row-split row-mod hunk-row';
        delRow.dataset.hunkid = hunkId;
        delRow.innerHTML =
          `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
          `<span class="dr-cell">${cd.aHtml || '&nbsp;'}</span>` +
          `<span class="dr-divider"></span>` +
          `<span class="dr-gutter"></span>` +
          `<span class="dr-cell">&nbsp;</span>`;
        wrapper.appendChild(delRow);
        const insRow = document.createElement('div');
        insRow.className = 'diff-row diff-row-split row-mod hunk-row';
        insRow.dataset.hunkid = hunkId;
        insRow.innerHTML =
          `<span class="dr-gutter dr-gutter-left"></span>` +
          `<span class="dr-cell">&nbsp;</span>` +
          `<span class="dr-divider"></span>` +
          `<span class="dr-gutter">${op.bIdx + 1}</span>` +
          `<span class="dr-cell">${cd.bHtml || '&nbsp;'}</span>`;
        wrapper.appendChild(insRow);
      }
    });
  } else {
    // Merge applied — show resolved rows
    hunk.opIndices.forEach(idx => {
      const op = lastOps[idx];
      let leftText = null, rightText = null, leftNum = '', rightNum = '';

      if (op.type === 'del') {
        if (ov === 'left') return; // line removed from left, nothing to show
        leftText  = op.text; leftNum  = op.aIdx + 1;
        rightText = op.text; rightNum = op.aIdx + 1;
      } else if (op.type === 'ins') {
        if (ov === 'right') return; // line removed from right, nothing to show
        leftText  = op.text; leftNum  = op.bIdx + 1;
        rightText = op.text; rightNum = op.bIdx + 1;
      } else if (op.type === 'mod') {
        const resolvedText = ov === 'left' ? op.bText : op.aText;
        leftText  = resolvedText; leftNum  = op.aIdx + 1;
        rightText = resolvedText; rightNum = op.bIdx + 1;
      }

      if (leftText === null && rightText === null) return;

      const row = document.createElement('div');
      row.className = 'diff-row diff-row-split row-ctx row-merged hunk-row';
      row.dataset.hunkid = hunkId;
      row.innerHTML =
        `<span class="dr-gutter dr-gutter-left">${leftNum}</span>` +
        `<span class="dr-cell">${escHtml(leftText ?? '')}</span>` +
        `<span class="dr-divider"></span>` +
        `<span class="dr-gutter">${rightNum}</span>` +
        `<span class="dr-cell">${escHtml(rightText ?? '')}</span>`;
      wrapper.appendChild(row);
    });
  }
}

// ── MERGE OUTPUT RECONSTRUCTION ──
// Merge Left  = push RIGHT content into the LEFT pane  (override 'left'  on a hunk → left gets right's version)
// Merge Right = push LEFT content into the RIGHT pane  (override 'right' on a hunk → right gets left's version)
//
// So for the LEFT pane:
//   no override   → keep left's original content (del keeps line, ins omits line, mod uses aText)
//   ov === 'left' → left gets the RIGHT version  (del omits line, ins includes line, mod uses bText)
//
// For the RIGHT pane:
//   no override    → keep right's original content
//   ov === 'right' → right gets the LEFT version  (del includes line, ins omits line, mod uses aText)

function buildMergedLines(side) {
  const opToHunk = new Map();
  for (const h of hunks) {
    for (const idx of h.opIndices) opToHunk.set(idx, h.id);
  }

  const lines = [];
  for (let idx = 0; idx < lastOps.length; idx++) {
    const op  = lastOps[idx];
    const hid = opToHunk.get(idx);
    const ov  = hid !== undefined ? mergeOverrides.get(hid) : undefined;

    if (op.type === 'eq') {
      lines.push(op.text);
    } else if (op.type === 'del') {
      // Original left has this line; original right doesn't.
      // Merge Left (ov==='left')  → left gets right's version → line omitted from left
      // Merge Right (ov==='right')→ right gets left's version → line added to right
      if (side === 'left') {
        if (ov !== 'left') lines.push(op.text);   // keep unless Merge Left was applied
      } else {
        if (ov === 'right') lines.push(op.text);  // right only gets it via Merge Right
      }
    } else if (op.type === 'ins') {
      // Original right has this line; original left doesn't.
      // Merge Left (ov==='left')  → left gets right's version → line added to left
      // Merge Right (ov==='right')→ right gets left's version → line omitted from right
      if (side === 'left') {
        if (ov === 'left') lines.push(op.text);   // left only gets it via Merge Left
      } else {
        if (ov !== 'right') lines.push(op.text);  // keep unless Merge Right was applied
      }
    } else if (op.type === 'mod') {
      // Merge Left  → left gets bText (right's version)
      // Merge Right → right gets aText (left's version)
      if (side === 'left') {
        lines.push(ov === 'left' ? op.bText : op.aText);
      } else {
        lines.push(ov === 'right' ? op.aText : op.bText);
      }
    }
  }
  return lines;
}

// ── UPDATE LIVE EDITOR PANES ──
// Writes the merged result back into the Before/After textareas so
// the user sees the change immediately in the source panes.

function updateEditorPanes() {
  const leftLines  = buildMergedLines('left');
  const rightLines = buildMergedLines('right');
  document.getElementById('left-editor').value  = leftLines.join('\n');
  document.getElementById('right-editor').value = rightLines.join('\n');
  updateLineCount('left');
  updateLineCount('right');
}

// ── OUTPUT PANEL ──

function toggleOutputPanel() {
  outputPanelOpen = !outputPanelOpen;
  document.getElementById('btn-output-panel').classList.toggle('active', outputPanelOpen);
  const panels = document.getElementById('output-panels');
  panels.classList.toggle('visible', outputPanelOpen);
  if (outputPanelOpen && lastOps.length > 0) renderOutputPanels();
}

function renderOutputPanels() {
  renderOutputSide('left',  buildMergedLines('left'));
  renderOutputSide('right', buildMergedLines('right'));

  const total  = hunks.length;
  const merged = mergeOverrides.size;
  const hint   = total > 0
    ? (merged > 0 ? `${merged} / ${total} resolved` : `${total} hunk${total !== 1 ? 's' : ''} — use merge buttons`)
    : 'No changes';
  document.getElementById('output-hint-left').textContent  = hint;
  document.getElementById('output-hint-right').textContent = hint;
}

function renderOutputSide(side, lines) {
  const container = document.getElementById('output-' + side);
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  const pad = String(lines.length).length;
  lines.forEach((line, i) => {
    const row = document.createElement('div');
    row.className = 'out-row';
    const num = String(i + 1).padStart(pad, ' ');
    row.innerHTML =
      `<span class="out-gutter">${escHtml(num)}</span>` +
      `<span class="out-cell">${escHtml(line)}</span>`;
    frag.appendChild(row);
  });
  if (!lines.length) {
    const empty = document.createElement('div');
    empty.className = 'out-empty';
    empty.textContent = '(empty)';
    frag.appendChild(empty);
  }
  container.appendChild(frag);
}

function copyOutput(side) {
  const text = buildMergedLines(side).join('\n');
  const btn  = document.getElementById('copy-btn-' + side);
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flashCopied(btn));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    flashCopied(btn);
  }
}

function flashCopied(btn) {
  const orig = btn.innerHTML;
  btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 8l4 4 8-8-1.5-1.5L6 9 3.5 6.5z"/></svg> Copied!`;
  btn.classList.add('copied');
  setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1600);
}

// ── RENDER HELPERS ──

// Returns the hunk that ends at or contains opIdx, or null if this op is the last in its hunk
// (used to decide when to insert the merge bar — after the last row of each hunk)
function isLastInHunk(opIdx) {
  for (const h of hunks) {
    const last = h.opIndices[h.opIndices.length - 1];
    if (last === opIdx) return h.id;
  }
  return null;
}

// ── RENDER SPLIT VIEW ──

function renderSplitView(ops) {
  const dv = document.getElementById('diff-view');
  dv.innerHTML = '';
  diffRows = [];
  const CONTEXT = 3;

  const fnameLeftSplit  = document.getElementById('fname-left').textContent;
  const fnameRightSplit = document.getElementById('fname-right').textContent;
  const header = document.createElement('div');
  header.className = 'diff-header';
  header.innerHTML =
    `<span class="dh-gutter">ORIG</span>` +
    `<span class="dh-cell dh-before">BEFORE <span class="dh-filename">${escHtml(fnameLeftSplit)}</span></span>` +
    `<span class="dh-divider"></span>` +
    `<span class="dh-gutter">MOD</span>` +
    `<span class="dh-cell dh-after">AFTER <span class="dh-filename">${escHtml(fnameRightSplit)}</span></span>`;
  dv.appendChild(header);

  const body = document.createElement('div');
  body.className = 'diff-body';
  dv.appendChild(body);

  const frag = document.createDocumentFragment();

  const visible = new Set();
  ops.forEach((op, idx) => {
    if (op.type !== 'eq')
      for (let c = Math.max(0, idx - CONTEXT); c <= Math.min(ops.length - 1, idx + CONTEXT); c++)
        visible.add(c);
  });

  let firstVisible = -1;
  for (let idx = 0; idx < ops.length; idx++) {
    if (visible.has(idx)) { firstVisible = idx; break; }
  }
  if (firstVisible > 0) {
    const fold = document.createElement('div');
    fold.className = 'diff-row diff-fold';
    fold.textContent = `··· ${firstVisible} unchanged line${firstVisible !== 1 ? 's' : ''} ···`;
    fold.addEventListener('click', () => expandFold(ops, 0, firstVisible - 1, fold, body));
    frag.appendChild(fold);
  }

  let prevVisible = -1;
  ops.forEach((op, idx) => {
    if (!visible.has(idx)) return;

    if (prevVisible !== -1 && idx > prevVisible + 1) {
      const fold = document.createElement('div');
      fold.className = 'diff-row diff-fold';
      const skipped = idx - prevVisible - 1;
      fold.textContent = `··· ${skipped} unchanged line${skipped !== 1 ? 's' : ''} ···`;
      const capturedPrev = prevVisible, capturedIdx = idx;
      fold.addEventListener('click', () => expandFold(ops, capturedPrev + 1, capturedIdx - 1, fold, body));
      frag.appendChild(fold);
    }

    const blockI = diffBlocks.findIndex(b => b.idx === idx);
    const hunk = hunks.find(h => h.opIndices.includes(idx));

    if (op.type === 'eq') {
      const row = document.createElement('div');
      row.className = 'diff-row diff-row-split row-ctx';
      row.innerHTML =
        `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
        `<span class="dr-cell">${escHtml(op.text)}</span>` +
        `<span class="dr-divider"></span>` +
        `<span class="dr-gutter">${op.bIdx + 1}</span>` +
        `<span class="dr-cell">${escHtml(op.text)}</span>`;
      frag.appendChild(row);
    } else {
      // Non-eq op — find or create the wrapper for this hunk
      let wrapper = hunk ? frag.querySelector(`.hunk-wrapper[data-hunkid="${hunk.id}"]`) : null;
      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'hunk-wrapper';
        if (hunk) {
          wrapper.dataset.hunkid = hunk.id;
          wrapper.addEventListener('click', () => selectHunk(hunk.id));
        }
        frag.appendChild(wrapper);
      }

      if (op.type === 'del') {
        const row = document.createElement('div');
        row.className = 'diff-row diff-row-split row-del hunk-row';
        if (hunk) row.dataset.hunkid = hunk.id;
        row.innerHTML =
          `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
          `<span class="dr-cell">${escHtml(op.text) || '&nbsp;'}</span>` +
          `<span class="dr-divider"></span>` +
          `<span class="dr-gutter"></span>` +
          `<span class="dr-cell">&nbsp;</span>`;
        if (blockI >= 0) diffRows[blockI] = row;
        wrapper.appendChild(row);
      } else if (op.type === 'ins') {
        const row = document.createElement('div');
        row.className = 'diff-row diff-row-split row-add hunk-row';
        if (hunk) row.dataset.hunkid = hunk.id;
        row.innerHTML =
          `<span class="dr-gutter dr-gutter-left"></span>` +
          `<span class="dr-cell">&nbsp;</span>` +
          `<span class="dr-divider"></span>` +
          `<span class="dr-gutter">${op.bIdx + 1}</span>` +
          `<span class="dr-cell">${escHtml(op.text) || '&nbsp;'}</span>`;
        if (blockI >= 0) diffRows[blockI] = row;
        wrapper.appendChild(row);
      } else if (op.type === 'mod') {
        const cd = charDiff(op.aText, op.bText);
        const delDiv = document.createElement('div');
        delDiv.className = 'diff-row diff-row-split row-mod hunk-row';
        if (hunk) delDiv.dataset.hunkid = hunk.id;
        delDiv.innerHTML =
          `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
          `<span class="dr-cell">${cd.aHtml || '&nbsp;'}</span>` +
          `<span class="dr-divider"></span>` +
          `<span class="dr-gutter"></span>` +
          `<span class="dr-cell">&nbsp;</span>`;
        if (blockI >= 0) diffRows[blockI] = delDiv;
        wrapper.appendChild(delDiv);
        const insDiv = document.createElement('div');
        insDiv.className = 'diff-row diff-row-split row-mod hunk-row';
        if (hunk) insDiv.dataset.hunkid = hunk.id;
        insDiv.innerHTML =
          `<span class="dr-gutter dr-gutter-left"></span>` +
          `<span class="dr-cell">&nbsp;</span>` +
          `<span class="dr-divider"></span>` +
          `<span class="dr-gutter">${op.bIdx + 1}</span>` +
          `<span class="dr-cell">${cd.bHtml || '&nbsp;'}</span>`;
        wrapper.appendChild(insDiv);
      }
    }

    // After the last op of each hunk, insert the merge bar after the wrapper
    const endHunkId = isLastInHunk(idx);
    if (endHunkId !== null) {
      frag.appendChild(makeMergeBar(endHunkId));
    }

    prevVisible = idx;
  });

  let lastVisible = -1;
  for (let idx = ops.length - 1; idx >= 0; idx--) {
    if (visible.has(idx)) { lastVisible = idx; break; }
  }
  if (lastVisible >= 0 && lastVisible < ops.length - 1) {
    const fold = document.createElement('div');
    fold.className = 'diff-row diff-fold';
    const skipped = ops.length - 1 - lastVisible;
    fold.textContent = `··· ${skipped} unchanged line${skipped !== 1 ? 's' : ''} ···`;
    fold.addEventListener('click', () => expandFold(ops, lastVisible + 1, ops.length - 1, fold, body));
    frag.appendChild(fold);
  }

  if (!ops.length || !diffBlocks.length) {
    const empty = document.createElement('div');
    empty.className = 'diff-row diff-empty';
    empty.textContent = 'No differences — files are identical';
    frag.appendChild(empty);
  }

  body.appendChild(frag);
}

// ── RENDER UNIFIED VIEW ──

function renderUnifiedView(ops) {
  const dv = document.getElementById('diff-view');
  dv.innerHTML = '';
  diffRows = [];
  const CONTEXT = 3;

  const fnameLeftUni  = document.getElementById('fname-left').textContent;
  const fnameRightUni = document.getElementById('fname-right').textContent;
  const header = document.createElement('div');
  header.className = 'diff-header';
  header.innerHTML =
    `<span class="dh-gutter">#</span>` +
    `<span class="dh-cell">UNIFIED DIFF <span class="dh-filename">${escHtml(fnameLeftUni)} → ${escHtml(fnameRightUni)}</span></span>`;
  dv.appendChild(header);

  const body = document.createElement('div');
  body.className = 'diff-body';
  dv.appendChild(body);

  const frag = document.createDocumentFragment();

  const visible = new Set();
  ops.forEach((op, idx) => {
    if (op.type !== 'eq')
      for (let c = Math.max(0, idx - CONTEXT); c <= Math.min(ops.length - 1, idx + CONTEXT); c++)
        visible.add(c);
  });

  let firstVisible = -1;
  for (let idx = 0; idx < ops.length; idx++) {
    if (visible.has(idx)) { firstVisible = idx; break; }
  }
  if (firstVisible > 0) {
    const fold = document.createElement('div');
    fold.className = 'diff-row diff-fold';
    fold.textContent = `··· ${firstVisible} unchanged line${firstVisible !== 1 ? 's' : ''} ···`;
    fold.addEventListener('click', () => expandFold(ops, 0, firstVisible - 1, fold, body));
    frag.appendChild(fold);
  }

  let prevVisible = -1;
  ops.forEach((op, idx) => {
    if (!visible.has(idx)) return;

    if (prevVisible !== -1 && idx > prevVisible + 1) {
      const fold = document.createElement('div');
      fold.className = 'diff-row diff-fold';
      const skipped = idx - prevVisible - 1;
      fold.textContent = `··· ${skipped} unchanged line${skipped !== 1 ? 's' : ''} ···`;
      const capturedPrev = prevVisible, capturedIdx = idx;
      fold.addEventListener('click', () => expandFold(ops, capturedPrev + 1, capturedIdx - 1, fold, body));
      frag.appendChild(fold);
    }

    const blockI = diffBlocks.findIndex(b => b.idx === idx);

    if (op.type === 'eq') {
      const row = document.createElement('div');
      row.className = 'diff-row diff-row-unified row-ctx';
      row.innerHTML =
        `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
        `<span class="dr-cell">  ${escHtml(op.text)}</span>`;
      frag.appendChild(row);
    } else if (op.type === 'del') {
      const row = document.createElement('div');
      row.className = 'diff-row diff-row-unified row-del';
      row.innerHTML =
        `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
        `<span class="dr-cell">− ${escHtml(op.text)}</span>`;
      if (blockI >= 0) diffRows[blockI] = row;
      frag.appendChild(row);
    } else if (op.type === 'ins') {
      const row = document.createElement('div');
      row.className = 'diff-row diff-row-unified row-add';
      row.innerHTML =
        `<span class="dr-gutter dr-gutter-left">${op.bIdx + 1}</span>` +
        `<span class="dr-cell">+ ${escHtml(op.text)}</span>`;
      if (blockI >= 0) diffRows[blockI] = row;
      frag.appendChild(row);
    } else if (op.type === 'mod') {
      const cd = charDiff(op.aText, op.bText);
      const del = document.createElement('div');
      del.className = 'diff-row diff-row-unified row-del';
      del.innerHTML =
        `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
        `<span class="dr-cell">− ${cd.aHtml}</span>`;
      if (blockI >= 0) diffRows[blockI] = del;
      frag.appendChild(del);
      const ins = document.createElement('div');
      ins.className = 'diff-row diff-row-unified row-add';
      ins.innerHTML =
        `<span class="dr-gutter dr-gutter-left">${op.bIdx + 1}</span>` +
        `<span class="dr-cell">+ ${cd.bHtml}</span>`;
      frag.appendChild(ins);
    }

    prevVisible = idx;
  });

  let lastVisible = -1;
  for (let idx = ops.length - 1; idx >= 0; idx--) {
    if (visible.has(idx)) { lastVisible = idx; break; }
  }
  if (lastVisible >= 0 && lastVisible < ops.length - 1) {
    const fold = document.createElement('div');
    fold.className = 'diff-row diff-fold';
    const skipped = ops.length - 1 - lastVisible;
    fold.textContent = `··· ${skipped} unchanged line${skipped !== 1 ? 's' : ''} ···`;
    fold.addEventListener('click', () => expandFold(ops, lastVisible + 1, ops.length - 1, fold, body));
    frag.appendChild(fold);
  }

  if (!ops.length || !diffBlocks.length) {
    const empty = document.createElement('div');
    empty.className = 'diff-row diff-empty';
    empty.textContent = 'No differences — files are identical';
    frag.appendChild(empty);
  }

  const inner = document.createElement('div');
  inner.className = 'diff-unified-inner';
  inner.appendChild(frag);
  body.appendChild(inner);
}

// ── EXPAND FOLD ──

function expandFold(ops, from, to, foldEl, body) {
  const frag = document.createDocumentFragment();
  for (let idx = from; idx <= to; idx++) {
    const op = ops[idx];
    const row = document.createElement('div');
    if (viewMode === 'split') {
      row.className = 'diff-row diff-row-split row-ctx';
      row.innerHTML =
        `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
        `<span class="dr-cell">${escHtml(op.text || '')}</span>` +
        `<span class="dr-divider"></span>` +
        `<span class="dr-gutter">${op.bIdx + 1}</span>` +
        `<span class="dr-cell">${escHtml(op.text || '')}</span>`;
    } else {
      row.className = 'diff-row diff-row-unified row-ctx';
      row.innerHTML =
        `<span class="dr-gutter dr-gutter-left">${op.aIdx + 1}</span>` +
        `<span class="dr-cell">  ${escHtml(op.text || '')}</span>`;
    }
    frag.appendChild(row);
  }
  foldEl.parentNode.insertBefore(frag, foldEl);
  foldEl.remove();
}

// ── JUMP ──

function jumpDiff(dir) {
  if (!diffBlocks.length) return;
  currentDiffIdx = (currentDiffIdx + dir + diffBlocks.length) % diffBlocks.length;
  jumpToBlock(currentDiffIdx);
}

function jumpToBlock(i) {
  currentDiffIdx = i;

  document.querySelectorAll('.diff-nav-item').forEach((el, idx) => el.classList.toggle('active', idx === i));
  document.querySelectorAll('.diff-nav-item')[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  document.querySelectorAll('.sheet-item').forEach((el, idx) => el.classList.toggle('active', idx === i));

  const row = diffRows[i];
  if (row) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  document.getElementById('jump-indicator').textContent = `${i + 1} / ${diffBlocks.length}`;
}

// ── SIDEBAR / SHEET ──

function toggleSidebar() {
  if (window.innerWidth > 700) {
    const sidebar = document.getElementById('sidebar');
    sidebarOpen = !sidebarOpen;
    sidebar.style.display = sidebarOpen ? 'flex' : 'none';
  } else {
    openSheet();
  }
}

function openSheet() {
  const sheet = document.getElementById('mobile-sheet');
  sheet.style.display = 'block';
  requestAnimationFrame(() => sheet.classList.add('open'));
}

function closeSheet() {
  const sheet = document.getElementById('mobile-sheet');
  sheet.classList.remove('open');
  setTimeout(() => { sheet.style.display = 'none'; }, 260);
}

// ── TOOLBAR ACTIONS ──

function clearAll() {
  if (worker) { worker.terminate(); worker = initWorker(); }
  isComputing = false;
  hideLoading();
  mergeOverrides = new Map();
  hunks = [];
  selectedHunkId = null;

  document.getElementById('left-editor').value = '';
  document.getElementById('right-editor').value = '';
  document.getElementById('fname-left').textContent = 'Original';
  document.getElementById('fname-right').textContent = 'Modified';
  document.getElementById('input-view').classList.remove('hidden');
  const dv = document.getElementById('diff-view');
  dv.classList.remove('visible');
  dv.innerHTML = '';
  document.getElementById('btn-compare').classList.remove('active');
  document.getElementById('jump-nav').style.display = 'none';
  document.getElementById('diff-nav').innerHTML = '';
  document.getElementById('sheet-list').innerHTML = '';
  document.getElementById('change-count').textContent = '0';
  document.getElementById('sheet-count').textContent = '0';
  document.getElementById('stat-add').textContent = '0';
  document.getElementById('stat-del').textContent = '0';
  document.getElementById('stat-mod').textContent = '0';
  document.getElementById('jump-indicator').textContent = '';
  document.getElementById('status-text').textContent = 'Ready — open files or paste text';
  document.getElementById('status-view-mode').style.display = 'none';
  document.getElementById('output-left').innerHTML = '';
  document.getElementById('output-right').innerHTML = '';
  document.getElementById('output-hint-left').textContent = '';
  document.getElementById('output-hint-right').textContent = '';
  updateLineCount('left');
  updateLineCount('right');
  diffBlocks = []; diffRows = []; currentDiffIdx = -1; lastOps = []; lastALines = []; lastBLines = [];
}

function swapPanes() {
  const l = document.getElementById('left-editor');
  const r = document.getElementById('right-editor');
  [l.value, r.value] = [r.value, l.value];
  const fl = document.getElementById('fname-left');
  const fr = document.getElementById('fname-right');
  [fl.textContent, fr.textContent] = [fr.textContent, fl.textContent];
  updateLineCount('left');
  updateLineCount('right');
  if (diffBlocks.length > 0) runDiff();
}

function toggleIgnoreWS() {
  ignoreWS = !ignoreWS;
  document.getElementById('btn-ignore-ws').classList.toggle('active', ignoreWS);
}

function setView(mode) {
  viewMode = mode;
  document.getElementById('vbtn-split').classList.toggle('active', mode === 'split');
  document.getElementById('vbtn-unified').classList.toggle('active', mode === 'unified');
  document.getElementById('status-view-mode').textContent = mode === 'split' ? 'Split View' : 'Unified View';
  if (diffBlocks.length > 0) runDiff();
}

// ── KEYBOARD SHORTCUTS ──
document.addEventListener('keydown', e => {
  if (e.key === 'F3')                                { e.preventDefault(); jumpDiff(e.shiftKey ? -1 : 1); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runDiff(); }
  if (e.key === 'Escape')                             { closeSheet(); }
});

// ── INIT ──
updateLineCount('left');
updateLineCount('right');
