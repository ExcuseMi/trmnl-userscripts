// ==UserScript==
// @name         TRMNL Editor Backups
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.3.2
// @description  Automatically snapshots the plugin archive before and after every save. View per-file diffs and restore any backup.
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings/*
// @match        https://trmnl.com/account*
// @icon         https://trmnl.com/favicon.ico
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/editor-backups.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/editor-backups.user.js
// @grant        none
// @run-at       document-body
// ==/UserScript==


(function () {
  'use strict';

  const LOG_PREFIX  = '[TRMNL Backups]';
  const log  = (...a) => console.log(LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);

  const PANEL_ID    = 'trmnl-backups-panel';
  const OVERLAY_ID  = 'trmnl-backups-overlay';
  const BTN_ID      = 'trmnl-backups-btn';
  const ACCT_BTN_ID = 'trmnl-backups-account-btn';
  const STYLE_ID    = 'trmnl-backups-style';
  const API_KEY_KEY = 'trmnl_backup_api_key';
  const CONFIG_KEY  = 'trmnl_backup_config';
  const PENDING_KEY = 'trmnl_pending_backup'; // sessionStorage — survives full-page reload
  const DEFAULT_CFG = { maxBackups: 15, maxAgeHours: 0 };

  // Preferred display order for archive files
  const FILE_ORDER = [
    'shared.liquid', 'full.liquid', 'half_horizontal.liquid',
    'half_vertical.liquid', 'quadrant.liquid',
    'settings.yml', 'transform.js',
  ];

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------

  function getPluginId() {
    const m = window.location.pathname.match(/\/plugin_settings\/(\d+)/);
    return m ? m[1] : null;
  }

  function isAccountPage() {
    return window.location.pathname.startsWith('/account');
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  function getConfig() {
    try {
      const s = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      return {
        maxBackups:  Math.max(1, Math.min(100, parseInt(s.maxBackups)  || DEFAULT_CFG.maxBackups)),
        maxAgeHours: Math.max(0,              parseInt(s.maxAgeHours) ?? DEFAULT_CFG.maxAgeHours),
      };
    } catch { return { ...DEFAULT_CFG }; }
  }

  function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }

  // ---------------------------------------------------------------------------
  // LocalStorage: backup entries per plugin
  // ---------------------------------------------------------------------------

  function bkKey(pluginId) { return `trmnl_backups_${pluginId}`; }

  function getBackups(pluginId) {
    try {
      let backups = JSON.parse(localStorage.getItem(bkKey(pluginId)) || '[]');
      const { maxAgeHours } = getConfig();
      if (maxAgeHours > 0) {
        const cutoff = Date.now() - maxAgeHours * 3_600_000;
        backups = backups.filter(e => e.timestamp >= cutoff);
      }
      return backups;
    } catch { return []; }
  }

  function saveBackups(pluginId, backups) {
    try { localStorage.setItem(bkKey(pluginId), JSON.stringify(backups)); }
    catch (e) { warn('localStorage error:', e.message); }
  }

  function addEntry(pluginId, beforeFiles) {
    const { maxBackups } = getConfig();
    const entry   = { id: Date.now(), timestamp: Date.now(), before: beforeFiles, after: null };
    const backups = getBackups(pluginId);
    backups.unshift(entry);
    if (backups.length > maxBackups) backups.length = maxBackups;
    saveBackups(pluginId, backups);
    refreshButtonCount();
    return entry.id;
  }

  function setEntryAfter(pluginId, entryId, afterFiles) {
    const backups = getBackups(pluginId);
    const idx     = backups.findIndex(e => e.id === entryId);
    if (idx === -1) return;
    const entry = backups[idx];
    entry.after = afterFiles;
    // Drop the entry entirely if nothing changed — no point keeping it
    if (changedFileNames(entry).length === 0) {
      log('No changes detected, discarding entry', entryId);
      backups.splice(idx, 1);
    }
    saveBackups(pluginId, backups);
    refreshButtonCount();
  }

  // ---------------------------------------------------------------------------
  // SessionStorage: pending "after" snapshot (survives full-page reload in tab)
  // ---------------------------------------------------------------------------

  function setPending(pluginId, entryId) {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ pluginId, entryId, ts: Date.now() }));
  }

  function clearPending() { sessionStorage.removeItem(PENDING_KEY); }

  function getPending() {
    try {
      const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
      if (p && Date.now() - p.ts < 30_000) return p;
    } catch {}
    return null;
  }

  // ---------------------------------------------------------------------------
  // Archive: fetch and build via JSZip
  // ---------------------------------------------------------------------------

  async function fetchArchive(pluginId) {
    const res = await fetch(`https://trmnl.com/api/plugin_settings/${pluginId}/archive`);
    if (!res.ok) throw new Error(`Archive fetch failed: ${res.status}`);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const files = {};
    await Promise.all(
      Object.entries(zip.files)
        .filter(([, entry]) => !entry.dir)
        .map(async ([name, entry]) => { files[name] = await entry.async('text'); })
    );
    return files;
  }

  async function buildZip(files) {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
      if (content) zip.file(name, content);
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    return new Blob([blob], { type: 'application/zip' });
  }

  // ---------------------------------------------------------------------------
  // File list helpers (dynamic — includes transform.js, settings.yml, etc.)
  // ---------------------------------------------------------------------------

  function getEntryFiles(entry) {
    const keys = new Set([
      ...Object.keys(entry.before),
      ...(entry.after ? Object.keys(entry.after) : []),
    ]);
    return [...keys].sort((a, b) => {
      const ai = FILE_ORDER.indexOf(a), bi = FILE_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  function changedFileNames(entry) {
    if (!entry.after) return [];
    return getEntryFiles(entry).filter(f => (entry.before[f] ?? '') !== (entry.after[f] ?? ''));
  }

  // ---------------------------------------------------------------------------
  // Form-submit interception
  // ---------------------------------------------------------------------------

  function findSaveForm() {
    const settingsForm = document.querySelector('form[id^="edit_plugin_setting"]');
    if (settingsForm) return settingsForm;
    const saveBtn = document.querySelector('[data-markup-target="enabledSaveButton"]');
    return saveBtn?.closest('form') ?? null;
  }

  function attachFormInterceptor(pluginId) {
    const form = findSaveForm();
    if (!form || form.dataset.backupAttached) return;
    form.dataset.backupAttached = 'true';

    let skipNext = false;
    form.addEventListener('submit', async (e) => {
      if (skipNext) { skipNext = false; return; }
      e.preventDefault();
      const submitter = e.submitter ?? null;
      try {
        const beforeFiles = await fetchArchive(pluginId);
        const entryId     = addEntry(pluginId, beforeFiles);
        setPending(pluginId, entryId);
        log('Backup snapshot created, entryId:', entryId);
      } catch (err) { warn('Pre-save snapshot failed:', err.message); /* never block the save */ }
      skipNext = true;
      form.requestSubmit(submitter);
    });
  }

  async function checkPendingBackup() {
    const p = getPending();
    if (!p) return;
    clearPending();
    try {
      const afterFiles = await fetchArchive(p.pluginId);
      setEntryAfter(p.pluginId, p.entryId, afterFiles);
      log('After-snapshot stored for entry:', p.entryId);
    } catch (err) { warn('After-snapshot failed:', err.message); }
  }

  // ---------------------------------------------------------------------------
  // Diff: LCS-based, line level
  // ---------------------------------------------------------------------------

  function diffLines(a, b) {
    const aL = a ? a.replace(/\r/g, '').split('\n') : [];
    const bL = b ? b.replace(/\r/g, '').split('\n') : [];
    const m  = Math.min(aL.length, 800);
    const n  = Math.min(bL.length, 800);

    const dp = Array.from({ length: m + 1 }, () => new Int16Array(n + 1));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = aL[i] === bL[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);

    const out = [];
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && aL[i] === bL[j]) { out.push({ t: 'eq',  l: aL[i] }); i++; j++; }
      // Prefer del before add (conventional order, enables intra-line pairing)
      else if (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1])) { out.push({ t: 'del', l: aL[i] }); i++; }
      else { out.push({ t: 'add', l: bL[j] }); j++; }
    }
    return out;
  }

  function buildDiffEl(oldText, newText) {
    if (oldText === newText) {
      const p = mk('p', 'text-xs text-gray-400 dark:text-gray-500 italic py-1');
      p.textContent = 'No changes in this file.';
      return p;
    }

    const CONTEXT = 3;
    const diff    = diffLines(oldText, newText);
    const show    = new Uint8Array(diff.length);
    for (let i = 0; i < diff.length; i++)
      if (diff[i].t !== 'eq')
        for (let k = Math.max(0, i - CONTEXT); k <= Math.min(diff.length - 1, i + CONTEXT); k++)
          show[k] = 1;

    const pre = mk('pre', 'bk-diff');
    let lastShown = -1;
    const rendered = new Uint8Array(diff.length);

    diff.forEach((d, idx) => {
      if (!show[idx] || rendered[idx]) return;
      if (lastShown !== -1 && idx > lastShown + 1) pre.appendChild(mk('div', 'bk-diff-skip', '···'));

      if (d.t === 'del') {
        // Collect the full consecutive run of dels then adds — pair them in order
        let k = idx;
        const dels = [], adds = [];
        while (k < diff.length && diff[k].t === 'del' && !rendered[k]) dels.push(k++);
        while (k < diff.length && diff[k].t === 'add' && !rendered[k]) adds.push(k++);
        dels.forEach(i => rendered[i] = 1);
        adds.forEach(i => rendered[i] = 1);

        const pairs = Math.min(dels.length, adds.length);
        for (let p = 0; p < pairs; p++) {
          const ol = diff[dels[p]].l, nl = diff[adds[p]].l;
          const dr = mk('div', 'bk-diff-del'); appendIntraLine(dr, '− ', ol, nl, 'bk-hl-del'); pre.appendChild(dr);
          const ar = mk('div', 'bk-diff-add'); appendIntraLine(ar, '+ ', nl, ol, 'bk-hl-add'); pre.appendChild(ar);
        }
        for (let p = pairs; p < dels.length; p++) {
          const row = mk('div', 'bk-diff-del'); row.textContent = '− ' + diff[dels[p]].l; pre.appendChild(row);
        }
        for (let p = pairs; p < adds.length; p++) {
          const row = mk('div', 'bk-diff-add'); row.textContent = '+ ' + diff[adds[p]].l; pre.appendChild(row);
        }
        lastShown = k - 1;
      } else {
        const row = mk('div', `bk-diff-${d.t}`);
        row.textContent = (d.t === 'add' ? '+ ' : '  ') + d.l;
        pre.appendChild(row);
        lastShown = idx;
      }
    });

    function appendIntraLine(row, marker, line, other, hlCls) {
      let p = 0;
      while (p < line.length && p < other.length && line[p] === other[p]) p++;
      let lEnd = line.length, oEnd = other.length;
      while (lEnd > p && oEnd > p && line[lEnd - 1] === other[oEnd - 1]) { lEnd--; oEnd--; }

      row.appendChild(document.createTextNode(marker + line.slice(0, p)));
      if (lEnd > p) row.appendChild(mk('mark', hlCls, line.slice(p, lEnd)));
      if (lEnd < line.length) row.appendChild(document.createTextNode(line.slice(lEnd)));
    }

    // Start expanded so diffs are immediately readable
    let expanded = true;
    pre.style.maxHeight = 'none';
    pre.style.overflowY = 'visible';

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className =
      'bk-expand-btn w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium ' +
      'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 ' +
      'border-t border-gray-200 dark:border-gray-700 cursor-pointer ' +
      'bg-gray-50 dark:bg-gray-800 transition-colors';

    const chevronDown = `<svg width="10" height="10" viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>`;
    const chevronUp   = `<svg width="10" height="10" viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,165.66a8,8,0,0,1-11.32,0L128,91.31,53.66,165.66A8,8,0,0,1,42.34,154.34l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,213.66,165.66Z"/></svg>`;

    expandBtn.innerHTML = `${chevronUp}<span>Collapse</span>`;
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      expanded = !expanded;
      pre.style.maxHeight = expanded ? 'none' : '12rem';
      pre.style.overflowY = expanded ? 'visible' : 'auto';
      expandBtn.innerHTML = expanded
        ? `${chevronUp}<span>Collapse</span>`
        : `${chevronDown}<span>Show full diff</span>`;
    });

    const wrap = mk('div', 'rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden mt-1');
    wrap.append(pre, expandBtn);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls)  el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function fmtDate(ts) {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  // ---------------------------------------------------------------------------
  // Panel: restore
  // ---------------------------------------------------------------------------

  async function doRestore(pluginId, files, btn) {
    const apiKey = localStorage.getItem(API_KEY_KEY) || '';
    if (!apiKey) { alert('Enter your API key in the Backups panel first.'); return; }
    const prev = btn.textContent;
    btn.textContent = 'Uploading…';
    btn.disabled    = true;
    try {
      const blob = await buildZip(files);
      const fd   = new FormData();
      fd.append('file', blob, 'archive.zip');
      const res  = await fetch(`https://trmnl.com/api/plugin_settings/${pluginId}/archive`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: fd,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? ' — ' + body.slice(0, 300) : ''}`);
      }
      log('Restore successful, redirecting…');
      btn.textContent = 'Done — redirecting…';
      setTimeout(() => {
        if (window.Turbo?.cache) window.Turbo.cache.clear();
        window.location.href = `https://trmnl.com/plugin_settings/${pluginId}/edit`;
      }, 800);
    } catch (e) {
      btn.textContent = prev;
      btn.disabled    = false;
      alert(`Restore failed: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Panel: single backup entry
  // ---------------------------------------------------------------------------

  function buildEntryEl(entry, pluginId) {
    const changed  = changedFileNames(entry);
    const allFiles = getEntryFiles(entry);
    const wrap     = mk('div', 'border-b border-gray-100 dark:border-gray-700/60');

    // Header row
    const header = mk('div',
      'flex items-center gap-2 px-4 py-2.5 cursor-pointer select-none ' +
      'hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors'
    );
    const arrow = mk('span', 'text-gray-400 dark:text-gray-600 text-xs w-3 flex-shrink-0', '▸');
    const ts    = mk('span', 'text-xs flex-1 font-medium text-gray-700 dark:text-gray-300', fmtDate(entry.timestamp));

    let badgeCls, badgeTxt;
    if (entry.imported)       { badgeCls = 'bk-badge-imported'; badgeTxt = 'imported'; }
    else if (!entry.after)    { badgeCls = 'bk-badge-pending';  badgeTxt = 'pending…'; }
    else if (!changed.length) { badgeCls = 'bk-badge-same';     badgeTxt = 'no changes'; }
    else                      { badgeCls = 'bk-badge-changed';  badgeTxt = `${changed.length} file${changed.length > 1 ? 's' : ''} changed`; }

    header.append(arrow, ts,
      mk('span', 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ' + badgeCls, badgeTxt)
    );
    wrap.appendChild(header);

    // Body (collapsed)
    const body = mk('div', 'px-4 pb-3 pt-1');
    body.style.display = 'none';

    // Restore buttons
    const actions = mk('div', 'flex gap-2 mb-3 flex-wrap');
    const restorePairs = entry.imported
      ? [['Restore', entry.after]]
      : [['Before', entry.before], ['After', entry.after]];
    restorePairs.forEach(([label, files]) => {
      if (!files) return;
      const btn = mk('button',
        'cursor-pointer font-medium rounded-lg text-xs px-3 py-1.5 inline-flex items-center ' +
        'transition duration-150 justify-center gap-1.5 whitespace-nowrap ' +
        'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 ' +
        'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50',
        entry.imported ? 'Restore this import' : `Restore "${label}"`
      );
      btn.type = 'button';
      btn.addEventListener('click', () => doRestore(pluginId, files, btn));
      actions.appendChild(btn);
    });
    body.appendChild(actions);

    // File tabs + diff views
    const tabs  = mk('div', 'flex gap-1 flex-wrap mb-2');
    const views = mk('div');

    const activeBase = 'bg-gray-900 text-white border-gray-900 dark:bg-primary-600 dark:text-white dark:border-primary-500';
    const changedBase  = 'border-emerald-400 dark:border-emerald-600 text-emerald-700 dark:text-emerald-400 bg-transparent hover:bg-emerald-50 dark:hover:bg-emerald-900/30';
    const defaultBase  = 'border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700';

    // Determine which tab to show first: first changed file, or first file if none
    const defaultIdx = changed.length > 0 ? allFiles.indexOf(changed[0]) : 0;

    const tabEls  = [];
    const viewEls = [];

    allFiles.forEach((name, i) => {
      const isChanged    = changed.includes(name);
      const inactiveBase = isChanged ? changedBase : defaultBase;
      const label        = name.replace('.liquid', '');

      const tab = mk('button',
        `px-2 py-0.5 text-xs font-mono border rounded-md cursor-pointer transition-colors ${inactiveBase}`,
        label
      );
      tab.type = 'button';
      tab.dataset.inactiveBase = inactiveBase;

      const view = mk('div');
      view.style.display = 'none';
      view.appendChild(
        !entry.after
          ? mk('p', 'text-xs text-gray-400 dark:text-gray-500 italic py-1', 'No "after" snapshot yet.')
          : buildDiffEl(entry.before[name] ?? '', entry.after[name] ?? '')
      );

      tab.addEventListener('click', () => {
        tabEls.forEach(t  => { t.className = `px-2 py-0.5 text-xs font-mono border rounded-md cursor-pointer transition-colors ${t.dataset.inactiveBase}`; });
        viewEls.forEach(v => { v.style.display = 'none'; });
        tab.className  = `px-2 py-0.5 text-xs font-mono border rounded-md cursor-pointer transition-colors ${activeBase}`;
        view.style.display = '';
      });

      tabEls.push(tab);
      viewEls.push(view);
      tabs.appendChild(tab);
      views.appendChild(view);
    });

    // Activate the default tab
    if (tabEls[defaultIdx]) {
      tabEls[defaultIdx].className = `px-2 py-0.5 text-xs font-mono border rounded-md cursor-pointer transition-colors ${activeBase}`;
      viewEls[defaultIdx].style.display = '';
    }

    body.append(tabs, views);
    wrap.appendChild(body);

    let open = false;
    header.addEventListener('click', () => {
      open = !open;
      arrow.textContent  = open ? '▾' : '▸';
      body.style.display = open ? '' : 'none';
    });

    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Panel: stepper control [−] N [+] with hold-to-repeat
  // ---------------------------------------------------------------------------

  function buildStepper(value, min, max, onChange) {
    const wrap = mk('div',
      'inline-flex items-center rounded-lg border border-gray-300 dark:border-gray-600 ' +
      'overflow-hidden bg-white dark:bg-gray-800'
    );

    function mkStepBtn(label) {
      const b = mk('button',
        'w-8 h-8 flex items-center justify-center text-sm font-medium ' +
        'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 ' +
        'transition-colors select-none flex-shrink-0',
        label
      );
      b.type = 'button';
      return b;
    }

    const dec = mkStepBtn('−');

    // Editable number input in the centre — type any value directly
    const inp = document.createElement('input');
    inp.type  = 'number';
    inp.value = String(value);
    inp.min   = String(min);
    inp.max   = String(max);
    inp.className =
      'w-14 text-center text-sm font-medium tabular-nums bg-transparent ' +
      'text-gray-900 dark:text-gray-100 border-0 focus:outline-none focus:ring-0 ' +
      'border-x border-gray-300 dark:border-gray-600 py-1 px-1 ' +
      '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

    const inc = mkStepBtn('+');

    let current = value;

    function commit(v) {
      current = Math.max(min, Math.min(max, isNaN(v) ? current : v));
      inp.value = String(current);
      onChange(current);
    }

    inp.addEventListener('change', () => commit(parseInt(inp.value, 10)));
    inp.addEventListener('blur',   () => commit(parseInt(inp.value, 10)));

    let timer, interval;
    function update(delta) { commit(current + delta); }
    function startRepeat(delta) {
      update(delta);
      timer = setTimeout(() => { interval = setInterval(() => update(delta), 80); }, 400);
    }
    function stopRepeat() { clearTimeout(timer); clearInterval(interval); }

    dec.addEventListener('mousedown', () => startRepeat(-1));
    inc.addEventListener('mousedown', () => startRepeat(+1));
    [dec, inc].forEach(b => {
      b.addEventListener('mouseup',    stopRepeat);
      b.addEventListener('mouseleave', stopRepeat);
    });

    wrap.append(dec, inp, inc);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Import from ZIP
  // ---------------------------------------------------------------------------

  async function importFromZip(pluginId, listEl) {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.zip,application/zip';

    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      log('Import: reading file:', file.name, 'size:', file.size, 'bytes');
      try {
        const arrayBuffer = await file.arrayBuffer();
        log('Import: parsing ZIP…');
        const zip = await JSZip.loadAsync(arrayBuffer);

        const zipEntries = Object.entries(zip.files).filter(([, e]) => !e.dir);
        log('Import: ZIP entries found:', zipEntries.map(([n]) => n));

        const files = {};
        await Promise.all(
          zipEntries.map(async ([name, e]) => {
            // Strip directory prefix (e.g. "plugin_256335/shared.liquid" → "shared.liquid")
            const basename = name.split('/').pop();
            if (basename) {
              files[basename] = await e.async('text');
              log(`Import: extracted "${basename}" — ${files[basename].length} chars`);
            }
          })
        );

        if (!Object.keys(files).length) { alert('ZIP contains no files.'); return; }
        log('Import: all files extracted:', Object.keys(files));

        // Check settings.yml id against current plugin
        const settingsYml = files['settings.yml'] || '';
        const idMatch = settingsYml.match(/^id:\s*(\d+)/m);
        if (idMatch && idMatch[1] !== pluginId) {
          const otherId = idMatch[1];
          const nameMatch = settingsYml.match(/^name:\s*(.+)/m);
          const nameNote = nameMatch ? ` ("${nameMatch[1].trim()}")` : '';
          const confirmed = confirm(
            `This ZIP belongs to plugin ${otherId}${nameNote}, but you're on plugin ${pluginId}.\n\n` +
            `Import anyway? The id in settings.yml will be updated to ${pluginId}.`
          );
          if (!confirmed) return;
          files['settings.yml'] = settingsYml.replace(/^id:\s*\d+/m, `id: ${pluginId}`);
          log(`Import: settings.yml id updated from ${otherId} to ${pluginId}`);
        }

        // Save to backup list
        const { maxBackups } = getConfig();
        const entry = {
          id: Date.now(), timestamp: Date.now(),
          before: {}, after: files, imported: true,
        };
        const backups = getBackups(pluginId);
        backups.unshift(entry);
        if (backups.length > maxBackups) backups.length = maxBackups;
        saveBackups(pluginId, backups);
        refreshButtonCount();

        const emptyMsg = listEl.querySelector('p');
        if (emptyMsg) emptyMsg.remove();
        listEl.prepend(buildEntryEl(entry, pluginId));
        log('Import: saved to backup list:', file.name, Object.keys(files));

        // Upload to TRMNL
        const apiKey = localStorage.getItem(API_KEY_KEY) || '';
        if (!apiKey) {
          alert('ZIP saved to backup list.\n\nSet your API key in the panel to upload it to TRMNL.');
          return;
        }

        log('Import: building ZIP for upload…');
        const blob = await buildZip(files);
        log('Import: ZIP blob size:', blob.size, 'bytes');
        const fd = new FormData();
        fd.append('file', blob, 'archive.zip');

        log(`Import: uploading to /api/plugin_settings/${pluginId}/archive…`);
        const res = await fetch(`https://trmnl.com/api/plugin_settings/${pluginId}/archive`, {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: fd,
        });
        log('Import: upload response status:', res.status);

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          warn('Import: upload failed body:', body);
          throw new Error(`HTTP ${res.status}${body ? ' — ' + body.slice(0, 300) : ''}`);
        }

        log('Import: upload successful, redirecting…');
        setTimeout(() => {
          if (window.Turbo?.cache) window.Turbo.cache.clear();
          window.location.href = `https://trmnl.com/plugin_settings/${pluginId}/edit`;
        }, 800);
      } catch (e) {
        warn('Import: failed:', e.message);
        alert(`Import failed: ${e.message}`);
      }
    });

    input.click();
  }

  // ---------------------------------------------------------------------------
  // Panel: build, open, close
  // ---------------------------------------------------------------------------

  function buildPanel(pluginId) {
    const overlay = mk('div', '');
    overlay.id = OVERLAY_ID;
    overlay.addEventListener('click', closePanel);

    const panel = mk('div', '');
    panel.id = PANEL_ID;

    // ── Header ──────────────────────────────────────────────────────────────
    const hdr   = mk('div',
      'flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0'
    );
    const iconBtnCls =
      'w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 ' +
      'hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';

    // Expand / restore panel width toggle
    let panelExpanded = false;
    const expandPanelBtn = mk('button', iconBtnCls);
    expandPanelBtn.type  = 'button';
    expandPanelBtn.title = 'Expand panel';
    expandPanelBtn.innerHTML =
      `<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor">` +
      `<path d="M224,48V96a8,8,0,0,1-16,0V67.31l-50.34,50.35a8,8,0,0,1-11.32-11.32L196.69,56H168a8,8,0,0,1,0-16h48A8,8,0,0,1,224,48ZM106.34,138.34,56,188.69V160a8,8,0,0,0-16,0v48a8,8,0,0,0,8,8H96a8,8,0,0,0,0-16H67.31l50.35-50.34a8,8,0,0,0-11.32-11.32Z"/>` +
      `</svg>`;
    expandPanelBtn.addEventListener('click', () => {
      panelExpanded = !panelExpanded;
      panel.style.width = panelExpanded ? 'min(95vw, 1100px)' : '';
      expandPanelBtn.title = panelExpanded ? 'Restore panel size' : 'Expand panel';
      expandPanelBtn.innerHTML = panelExpanded
        ? `<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M221.66,165.66l-48,48a8,8,0,0,1-11.32-11.32L204.69,160H176a8,8,0,0,1,0-16h48a8,8,0,0,1,8,8v48a8,8,0,0,1-16,0V171.31ZM80,96H51.31l42.35-42.34A8,8,0,0,0,82.34,42.34l-48,48A8,8,0,0,0,32,96v48a8,8,0,0,0,16,0V115.31l42.34,42.35a8,8,0,0,0,11.32-11.32Z"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M224,48V96a8,8,0,0,1-16,0V67.31l-50.34,50.35a8,8,0,0,1-11.32-11.32L196.69,56H168a8,8,0,0,1,0-16h48A8,8,0,0,1,224,48ZM106.34,138.34,56,188.69V160a8,8,0,0,0-16,0v48a8,8,0,0,0,8,8H96a8,8,0,0,0,0-16H67.31l50.35-50.34a8,8,0,0,0-11.32-11.32Z"/></svg>`;
    });

    const close = mk('button', iconBtnCls, '✕');
    close.type = 'button';
    close.addEventListener('click', closePanel);
    const hdrBtns = mk('div', 'flex items-center gap-1 ml-auto');
    hdrBtns.append(expandPanelBtn, close);
    hdr.append(mk('span', 'text-sm font-semibold text-gray-900 dark:text-gray-100', 'Plugin Backups'), hdrBtns);
    panel.appendChild(hdr);

    // ── API Key ──────────────────────────────────────────────────────────────
    const apiKey = localStorage.getItem(API_KEY_KEY) || '';
    const apiSec = mk('div',
      'px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0'
    );
    apiSec.appendChild(mk('p',
      'text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2',
      'API Key'
    ));

    const apiRow = mk('div', 'flex items-center gap-2 flex-wrap');

    if (apiKey) {
      const chip = mk('span',
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bk-chip-set',
        '✓ API key saved'
      );
      const changeBtn = mk('button',
        'text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 ' +
        'underline cursor-pointer bg-transparent border-0',
        'Change'
      );
      changeBtn.type = 'button';

      const inputWrap = mk('div', 'w-full mt-2 hidden');
      const apiIn = mk('input',
        'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg ' +
        'bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 ' +
        'focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-500 focus:border-blue-500'
      );
      apiIn.type = 'password';
      apiIn.placeholder = 'user_xxxxx';
      apiIn.value = apiKey;
      apiIn.style.boxSizing = 'border-box';
      apiIn.addEventListener('change', () => {
        const v = apiIn.value.trim();
        v ? localStorage.setItem(API_KEY_KEY, v) : localStorage.removeItem(API_KEY_KEY);
      });
      inputWrap.appendChild(apiIn);

      changeBtn.addEventListener('click', () => {
        inputWrap.classList.toggle('hidden');
        if (!inputWrap.classList.contains('hidden')) apiIn.focus();
      });

      apiRow.append(chip, changeBtn);
      apiSec.append(apiRow, inputWrap);
    } else {
      const notSet = mk('span',
        'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bk-chip-unset',
        'Not set'
      );
      const setBtn = mk('button',
        'cursor-pointer font-medium rounded-lg text-xs px-3 py-1.5 inline-flex items-center ' +
        'transition duration-150 justify-center gap-1.5 border-0 ' +
        'text-white bg-primary-500 dark:bg-primary-600 hover:bg-primary-600 dark:hover:bg-primary-500 ' +
        'focus:outline-none',
        'Set API Key'
      );
      setBtn.type = 'button';

      const inputWrap = mk('div', 'w-full mt-2 hidden');
      const apiIn = mk('input',
        'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg ' +
        'bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 ' +
        'focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
      );
      apiIn.type = 'password';
      apiIn.placeholder = 'user_xxxxx';
      apiIn.style.boxSizing = 'border-box';

      const saveKeyBtn = mk('button',
        'mt-2 cursor-pointer font-medium rounded-lg text-xs px-3 py-1.5 inline-flex items-center ' +
        'transition duration-150 gap-1.5 border-0 ' +
        'text-white bg-primary-500 dark:bg-primary-600 hover:bg-primary-600 dark:hover:bg-primary-500 ' +
        'focus:outline-none',
        'Save'
      );
      saveKeyBtn.type = 'button';
      saveKeyBtn.addEventListener('click', () => {
        const v = apiIn.value.trim();
        if (!v) return;
        localStorage.setItem(API_KEY_KEY, v);
        notSet.className = 'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bk-chip-set';
        notSet.textContent = '✓ API key saved';
        inputWrap.classList.add('hidden');
      });

      inputWrap.append(apiIn, saveKeyBtn);
      setBtn.addEventListener('click', () => {
        inputWrap.classList.toggle('hidden');
        if (!inputWrap.classList.contains('hidden')) apiIn.focus();
      });

      apiRow.append(notSet, setBtn);
      apiSec.append(apiRow, inputWrap);
    }

    apiSec.appendChild(mk('p',
      'text-xs text-gray-400 dark:text-gray-500 mt-2',
      'Required only for restoring. Stored in localStorage.'
    ));
    panel.appendChild(apiSec);

    // ── Backup Settings ──────────────────────────────────────────────────────
    const cfg    = getConfig();
    const cfgSec = mk('div',
      'px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0'
    );
    cfgSec.appendChild(mk('p',
      'text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3',
      'Backup Settings'
    ));

    const cfgRow = mk('div', 'flex items-start gap-6 flex-wrap');

    const maxWrap = mk('div', 'flex flex-col gap-1.5');
    maxWrap.appendChild(mk('label', 'text-xs font-medium text-gray-600 dark:text-gray-400', 'Max backups'));
    maxWrap.appendChild(buildStepper(cfg.maxBackups, 1, 100,
      v => saveConfig({ ...getConfig(), maxBackups: v })
    ));

    const ageWrap = mk('div', 'flex flex-col gap-1.5');
    ageWrap.appendChild(mk('label', 'text-xs font-medium text-gray-600 dark:text-gray-400', 'Keep (hours)'));
    ageWrap.appendChild(buildStepper(cfg.maxAgeHours, 0, 8760,
      v => saveConfig({ ...getConfig(), maxAgeHours: v })
    ));
    ageWrap.appendChild(mk('p', 'text-xs text-gray-400 dark:text-gray-500', '0 = keep forever'));

    // Storage sizes
    function formatBytes(b) {
      if (b < 1024) return `${b} B`;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
      return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    }
    const pluginRaw = localStorage.getItem(bkKey(pluginId)) || '';
    let totalRaw = '';
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('trmnl_backups_')) totalRaw += localStorage.getItem(k) || '';
    }
    const sizeInfo = mk('p',
      'text-xs text-gray-400 dark:text-gray-500 mt-3',
      `This plugin: ${formatBytes(new Blob([pluginRaw]).size)} · All plugins: ${formatBytes(new Blob([totalRaw]).size)}`
    );

    cfgRow.append(maxWrap, ageWrap);
    cfgSec.append(cfgRow, sizeInfo);
    panel.appendChild(cfgSec);

    // ── List header ──────────────────────────────────────────────────────────
    const listHdr = mk('div',
      'flex items-center justify-between px-5 py-2 text-xs font-semibold uppercase ' +
      'tracking-wider text-gray-500 dark:text-gray-400 flex-shrink-0'
    );
    const importB = mk('button',
      'text-xs text-primary-500 dark:text-primary-400 hover:underline bg-transparent border-0 cursor-pointer',
      '↑ Import ZIP'
    );
    importB.type = 'button';
    importB.addEventListener('click', () => importFromZip(pluginId, listEl));

    const clearB = mk('button',
      'text-xs text-red-500 dark:text-red-400 hover:underline bg-transparent border-0 cursor-pointer',
      'Clear all'
    );
    clearB.type = 'button';
    clearB.addEventListener('click', () => {
      if (!confirm('Delete all backups for this plugin?')) return;
      localStorage.removeItem(bkKey(pluginId));
      listEl.replaceChildren(
        mk('p', 'text-xs text-gray-400 dark:text-gray-500 text-center py-8',
          'No backups yet. Save your plugin to create one.')
      );
      refreshButtonCount();
    });

    const listActions = mk('div', 'flex items-center gap-3');
    listActions.append(importB, clearB);
    listHdr.append(mk('span', '', `Plugin ${pluginId}`), listActions);
    panel.appendChild(listHdr);

    // ── Backup list ──────────────────────────────────────────────────────────
    const listEl  = mk('div', 'flex-1 overflow-y-auto');
    const backups = getBackups(pluginId);
    if (!backups.length) {
      listEl.appendChild(
        mk('p', 'text-xs text-gray-400 dark:text-gray-500 text-center py-8',
          'No backups yet. Save your plugin to create one.')
      );
    } else {
      backups.forEach(e => listEl.appendChild(buildEntryEl(e, pluginId)));
    }
    panel.appendChild(listEl);

    document.body.append(overlay, panel);
    requestAnimationFrame(() => {
      overlay.classList.add('bk-visible');
      panel.classList.add('bk-visible');
    });
  }

  function closePanel() {
    [PANEL_ID, OVERLAY_ID].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('bk-visible');
      setTimeout(() => el.remove(), 300);
    });
  }

  function openPanel() {
    if (document.getElementById(PANEL_ID)) { closePanel(); return; }
    const pluginId = getPluginId();
    if (!pluginId) return;
    buildPanel(pluginId);
  }

  // ---------------------------------------------------------------------------
  // Header button (page title row) — all plugin_settings pages
  // ---------------------------------------------------------------------------

  function refreshButtonCount() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const pluginId = getPluginId();
    const count    = pluginId ? getBackups(pluginId).length : 0;
    const span     = btn.querySelector('[data-bk-count]');
    if (span) span.textContent = String(count);
    btn.style.display = count > 0 ? '' : 'none';
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return true;
    // Only show on specific plugin pages (not the list page)
    const pluginId = getPluginId();
    if (!pluginId) return true; // nothing to inject; stop observing

    const h2 = document.querySelector('h2.font-heading');
    if (!h2) return false;
    const headerFlex = h2.parentElement;
    if (!headerFlex) return false;

    const count = getBackups(pluginId).length;

    const btn = mk('button',
      'inline-flex items-center gap-1.5 px-2.5 py-1 flex-shrink-0 ' +
      'text-xs font-medium rounded-full border cursor-pointer transition-colors ' +
      'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 ' +
      'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 ' +
      'focus:outline-none focus:ring-2 focus:ring-primary-500'
    );
    btn.id    = BTN_ID;
    btn.type  = 'button';
    btn.title = 'Plugin Backups';
    btn.style.display = count > 0 ? '' : 'none';
    btn.innerHTML =
      `<svg width="16" height="16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">` +
      `<path d="M136,80v43.47l36.12,21.67a8,8,0,0,1-8.24,13.72l-40-24A8,8,0,0,1,120,128V80a8,8,0,0,1,16,0Zm-8-48A95.44,95.44,0,0,0,60.08,60.15L52,52a8,8,0,0,0-13.66,5.61l-.77,42.46a8,8,0,0,0,8,8.14l42.47-.77A8,8,0,0,0,93.61,94.1L84.4,84.87a79.56,79.56,0,1,1-1.32,95.46,8,8,0,1,0-13,9.26A96,96,0,1,0,128,32Z"/>` +
      `</svg><span data-bk-count>${count}</span>`;
    btn.addEventListener('click', openPanel);

    // Place button inline with the h2 title
    const h2Row = mk('div', 'flex items-center gap-2');
    h2.parentNode.insertBefore(h2Row, h2);
    h2Row.appendChild(h2);
    h2Row.appendChild(btn);
    log('Button injected for plugin', pluginId);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Account page: "Use in Backup Script" button next to API key
  // ---------------------------------------------------------------------------

  function injectAccountButton() {
    if (document.getElementById(ACCT_BTN_ID)) return true;
    const apiInput = document.querySelector('input[id$="-apiKey-copy-btn"]');
    if (!apiInput) return false;
    const apiValue = apiInput.value.trim();
    if (!apiValue) return false;

    const isAlreadySaved = localStorage.getItem(API_KEY_KEY) === apiValue;
    const baseBtnCls =
      'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border ' +
      'cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 mt-3 ';
    const clsDefault = 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 ' +
      'text-gray-700 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700';
    const clsSaved   = 'text-primary-500 bg-primary-100 dark:bg-primary-900 ' +
      'border-primary-300 dark:border-primary-700';

    const btn = mk('button',
      baseBtnCls + (isAlreadySaved ? clsSaved : clsDefault),
      isAlreadySaved ? '✓ Saved in Backups' : '↓ Use in Backup Script'
    );
    btn.id   = ACCT_BTN_ID;
    btn.type = 'button';

    btn.addEventListener('click', () => {
      localStorage.setItem(API_KEY_KEY, apiValue);
      btn.textContent = '✓ Saved in Backups';
      btn.className   = baseBtnCls + clsSaved;
    });

    // Insert below the API key section, after the docs paragraph
    const flexRow = apiInput.closest('.flex.items-center');
    if (!flexRow) return false;
    const container = flexRow.closest('.p-6') || flexRow.parentElement;
    const docsP = container.querySelector('a[href*="help.trmnl.com"]')?.closest('p');
    if (docsP) {
      docsP.insertAdjacentElement('afterend', btn);
    } else {
      container.appendChild(btn);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Styles — minimal: only what Tailwind can't handle
  // ---------------------------------------------------------------------------

function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = mk('style');
    s.id = STYLE_ID;
    s.textContent = `
      /* Overlay */
      #${OVERLAY_ID} {
        position:fixed; inset:0; background:rgba(0,0,0,.45);
        z-index:9998; opacity:0; transition:opacity .25s;
      }
      #${OVERLAY_ID}.bk-visible { opacity:1; }

      /* Slide-in panel */
      /* Slide-in panel */
      #${PANEL_ID} {
        position:fixed; top:0; right:0; bottom:0; width:min(580px,95vw);
        background:#fff; z-index:9999;
        box-shadow:-4px 0 40px rgba(0,0,0,.15);
        display:flex; flex-direction:column;
        transform:translateX(100%);
        transition:transform .3s cubic-bezier(.4,0,.2,1);
        font-family:ui-sans-serif,system-ui,sans-serif;
        font-size:13px; color:#111827;
      }
      #${PANEL_ID}.bk-visible { transform:translateX(0); }
      .dark #${PANEL_ID} { background:#111827; color:#e5e7eb; }

      /* Backup entry hover fix */
      #${PANEL_ID} .hover\\:bg-gray-50:hover,
      #${PANEL_ID} .dark\\:hover\\:bg-gray-800\\/60:hover {
        color: inherit;
      }
      #${PANEL_ID} .hover\\:bg-gray-50:hover .text-gray-700,
      #${PANEL_ID} .dark\\:hover\\:bg-gray-800\\/60:hover .dark\\:text-gray-300 {
        color: inherit;
      }

      /* Diff */
      .bk-diff {
        font-family:ui-monospace,'Cascadia Code',monospace;
        font-size:11px; line-height:1.6; margin:0;
        white-space:pre-wrap; word-break:break-all; overflow-wrap:anywhere;
        padding:8px 10px;
        max-height:12rem; overflow-y:auto;
        background:#f8fafc;
      }
      .dark .bk-diff { background:#0f172a; }
      .bk-diff-add  { background:#dcfce7; color:#15803d; display:block; }
      .bk-diff-del  { background:#fee2e2; color:#dc2626; display:block; }
      .bk-diff-eq   { color:#9ca3af; display:block; }
      .bk-diff-skip { color:#d1d5db; font-style:italic; display:block; padding-left:1.5rem; }
      .dark .bk-diff-add { background:#14532d; color:#86efac; }
      .dark .bk-diff-del { background:#7f1d1d; color:#fca5a5; }
      .dark .bk-diff-eq  { color:#374151; }
      .dark .bk-diff-skip { color:#4b5563; }
      .bk-hl-del, .bk-hl-add { border-radius:2px; padding:0 1px; color:inherit; }
      .bk-hl-del { background:rgba(185,28,28,0.25); }
      .bk-hl-add { background:rgba(21,128,61,0.25); }
      .dark .bk-hl-del { background:rgba(252,165,165,0.3); }
      .dark .bk-hl-add { background:rgba(134,239,172,0.3); }

      /* Expand button */
      .bk-expand-btn { display:flex; border:0; font-family:inherit; }

      /* Badges */
      .bk-badge-changed  { background:#dcfce7; color:#15803d; }
      .bk-badge-same     { background:#f3f4f6; color:#6b7280; }
      .bk-badge-pending  { background:#fef9c3; color:#854d0e; }
      .bk-badge-imported { background:#ede9fe; color:#6d28d9; }
      .dark .bk-badge-changed  { background:#14532d; color:#86efac; }
      .dark .bk-badge-same     { background:#1f2937; color:#9ca3af; }
      .dark .bk-badge-pending  { background:#422006; color:#fde68a; }
      .dark .bk-badge-imported { background:#2e1065; color:#c4b5fd; }

      /* API key chip — uses custom CSS because Tailwind opacity utilities (/30)
         may not be compiled into the site's stylesheet */
      .bk-chip-set {
        background:#f0fdf4; color:#15803d;
        border:1px solid #bbf7d0;
      }
      .dark .bk-chip-set {
        background:rgba(6,78,59,.25); color:#6ee7b7;
        border:1px solid rgba(52,211,153,.3);
      }
      .bk-chip-unset {
        background:#f3f4f6; color:#6b7280;
        border:1px solid #e5e7eb;
      }
      .dark .bk-chip-unset {
        background:#1f2937; color:#9ca3af;
        border:1px solid #374151;
      }
    `;
    document.head.appendChild(s);
  }
  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function setup() {
    injectStyle();
    checkPendingBackup();

    if (isAccountPage()) {
      if (!injectAccountButton()) {
        const obs = new MutationObserver(() => { if (injectAccountButton()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => obs.disconnect(), 15_000);
      }
      return;
    }

    const pluginId = getPluginId();
    if (!pluginId) return;

    function tryAttachForm() {
      attachFormInterceptor(pluginId);
      return !!document.querySelector('form[data-backup-attached]');
    }

    if (!tryAttachForm()) {
      const obs = new MutationObserver(() => { if (tryAttachForm()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 60_000);
    }

    if (!injectButton()) {
      const obs = new MutationObserver(() => { if (injectButton()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  document.addEventListener('turbo:load', () => {
    checkPendingBackup();
    closePanel();

    if (isAccountPage()) {
      injectAccountButton();
      return;
    }

    const pluginId = getPluginId();
    if (pluginId) attachFormInterceptor(pluginId);
    injectButton();
    refreshButtonCount();
  });

  log('Script loaded.');
  setup();

})();
