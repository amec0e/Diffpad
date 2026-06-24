// ── DIFFPAD WEB WORKER ──
// Runs the entire diff computation off the main thread.
// Receives: { aLines, bLines, ignoreWS }
// Posts back: { ops, adds, dels, mods, prefixLen, suffixLen }

self.onmessage = function(e) {
  const { aLines, bLines, ignoreWS } = e.data;

  // ── 1. Early exit: identical ──
  if (aLines.join('\n') === bLines.join('\n')) {
    const ops = aLines.map((text, i) => ({ type: 'eq', aIdx: i, bIdx: i, text }));
    self.postMessage({ ops, adds: 0, dels: 0, mods: 0 });
    return;
  }

  // ── 2. Normalise for comparison if ignoreWS ──
  const norm = lines => ignoreWS
    ? lines.map(l => l.replace(/\s+/g, ' ').trim())
    : lines;

  const aNorm = norm(aLines);
  const bNorm = norm(bLines);

  // ── 3. Strip common prefix ──
  let prefixLen = 0;
  const minLen = Math.min(aNorm.length, bNorm.length);
  while (prefixLen < minLen && aNorm[prefixLen] === bNorm[prefixLen]) prefixLen++;

  // ── 4. Strip common suffix (from what's left after prefix) ──
  let suffixLen = 0;
  const aRest = aNorm.length - prefixLen;
  const bRest = bNorm.length - prefixLen;
  const maxSuffix = Math.min(aRest, bRest);
  while (
    suffixLen < maxSuffix &&
    aNorm[aNorm.length - 1 - suffixLen] === bNorm[bNorm.length - 1 - suffixLen]
  ) suffixLen++;

  // Slice to just the differing middle section
  const aMid = aLines.slice(prefixLen, aLines.length - suffixLen || undefined);
  const bMid = bLines.slice(prefixLen, bLines.length - suffixLen || undefined);
  const aMidNorm = aNorm.slice(prefixLen, aNorm.length - suffixLen || undefined);
  const bMidNorm = bNorm.slice(prefixLen, bNorm.length - suffixLen || undefined);

  // ── 5. LCS on the trimmed middle ──
  const midOps = computeDiff(aMid, bMid, aMidNorm, bMidNorm, prefixLen);

  // ── 6. Reassemble: prefix + mid + suffix ──
  const ops = [];

  for (let i = 0; i < prefixLen; i++) {
    ops.push({ type: 'eq', aIdx: i, bIdx: i, text: aLines[i] });
  }

  ops.push(...midOps);

  for (let i = 0; i < suffixLen; i++) {
    const aI = aLines.length - suffixLen + i;
    const bI = bLines.length - suffixLen + i;
    ops.push({ type: 'eq', aIdx: aI, bIdx: bI, text: aLines[aI] });
  }

  // ── 7. Merge adjacent del+ins into mod ──
  const merged = mergeOps(ops);

  // ── 8. Count ──
  let adds = 0, dels = 0, mods = 0;
  for (const op of merged) {
    if (op.type === 'ins') adds++;
    else if (op.type === 'del') dels++;
    else if (op.type === 'mod') mods++;
  }

  self.postMessage({ ops: merged, adds, dels, mods });
};

// ── LCS DIFF on a slice ──
function computeDiff(aLines, bLines, aNorm, bNorm, aOffset) {
  const m = aNorm.length, n = bNorm.length;
  if (m === 0 && n === 0) return [];

  // Pure insertion block
  if (m === 0) {
    return bLines.map((text, j) => ({
      type: 'ins', bIdx: aOffset + j, text
    }));
  }
  // Pure deletion block
  if (n === 0) {
    return aLines.map((text, i) => ({
      type: 'del', aIdx: aOffset + i, text
    }));
  }

  // LCS DP — use flat Int32Array for memory efficiency
  const dp = new Int32Array((m + 1) * (n + 1));
  const W = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * W + j] = aNorm[i] === bNorm[j]
        ? dp[(i + 1) * W + (j + 1)] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
    }
  }

  // Traceback
  const ops = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aNorm[i] === bNorm[j]) {
      ops.push({ type: 'eq', aIdx: aOffset + i, bIdx: aOffset + j, text: aLines[i] });
      i++; j++;
    } else if (j < n && (i >= m || dp[(i) * W + (j + 1)] >= dp[(i + 1) * W + j])) {
      ops.push({ type: 'ins', bIdx: aOffset + j, text: bLines[j] });
      j++;
    } else {
      ops.push({ type: 'del', aIdx: aOffset + i, text: aLines[i] });
      i++;
    }
  }
  return ops;
}

// Merge adjacent del+ins → mod
function mergeOps(ops) {
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'del' && k + 1 < ops.length && ops[k + 1].type === 'ins') {
      out.push({
        type: 'mod',
        aIdx: ops[k].aIdx,
        bIdx: ops[k + 1].bIdx,
        aText: ops[k].text,
        bText: ops[k + 1].text
      });
      k += 2;
    } else {
      out.push(ops[k]);
      k++;
    }
  }
  return out;
}
