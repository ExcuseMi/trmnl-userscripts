// ==UserScript==
// @name         TRMNL GitHub Sync
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      0.1.1
// @description  Push your TRMNL plugin code to a GitHub repository and pull it back on demand.
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @icon         https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/refs/heads/main/images/trmnl.svg
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/github-sync.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/github-sync.user.js
// @grant        none
// @run-at       document-body
// ==/UserScript==

(function () {
  'use strict';

  const LOG_PREFIX = '[TRMNL GH Sync]';
  const log  = (...a) => console.log(LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);

  const PANEL_ID    = 'trmnl-gh-panel';
  const OVERLAY_ID  = 'trmnl-gh-overlay';
  const BTN_ID      = 'trmnl-gh-btn';
  const ACCT_BTN_ID = 'trmnl-gh-account-btn';
  const PUSH_BTN_ID = 'trmnl-gh-push-btn';   // quick push in page header
  const PULL_BTN_ID = 'trmnl-gh-pull-btn';   // pull indicator in page header
  const STYLE_ID    = 'trmnl-gh-style';
  const LAST_PUSH_SHAS_KEY = 'trmnl_gh_shas';      // prefix; keyed per plugin
  const LAST_PUSH_TIME_KEY = 'trmnl_gh_push_time'; // timestamp of last push, per plugin
  const LIST_BADGE_ATTR    = 'data-gh-sync-badge';  // marks rows on plugin list page

  // Storage keys
  const GH_TOKEN_KEY  = 'trmnl_gh_token';
  const GH_CONFIG_KEY = 'trmnl_gh_config';
  const GH_API_KEY        = 'trmnl_gh_api_key';    // TRMNL API key for uploads
  const GH_CONFIG_REPO_KEY   = 'trmnl_gh_config_repo';   // optional global config repo (owner/repo)

  const DEFAULT_CONFIG = {
    repo:      '',          // "owner/repo"
    branch:    'main',
    path:      'plugin',
    commitMsg: 'TRMNL sync: {name} (plugin {id})',
    autoPush:  false,
  };

  const AUTOPUSH_KEY       = 'trmnl_gh_autopush_pending'; // sessionStorage
  const REMOTE_CONFIG_FILE = '.trmnl-sync.json';          // stored at repo root

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------

  function getPluginId() {
    const m = window.location.pathname.match(/\/plugin_settings\/(\d+)/);
    return m ? m[1] : null;
  }

  function getPluginName() {
    // Try the settings/edit page heading first
    const h2 = document.querySelector('h2.font-heading');
    if (h2) return h2.textContent.trim();
    // On markup/edit and other sub-pages, look for a breadcrumb or nav link
    // that contains the plugin name (typically an ancestor link to /edit)
    const crumb = document.querySelector('a[href*="/plugin_settings/"][href$="/edit"]');
    if (crumb) return crumb.textContent.trim();
    return '';
  }

  function isAccountPage() {
    return window.location.pathname.startsWith('/account');
  }

  // ---------------------------------------------------------------------------
  // Config / token helpers
  // ---------------------------------------------------------------------------

  function cfgKey(pluginId) { return `${GH_CONFIG_KEY}_${pluginId}`; }

  function getConfig(pluginId) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(cfgKey(pluginId)) || '{}') };
    } catch { return { ...DEFAULT_CONFIG }; }
  }

  function saveConfig(pluginId, cfg) {
    localStorage.setItem(cfgKey(pluginId), JSON.stringify(cfg));
  }

  function getToken()        { return localStorage.getItem(GH_TOKEN_KEY) || ''; }
  function saveToken(t)      { t ? localStorage.setItem(GH_TOKEN_KEY, t) : localStorage.removeItem(GH_TOKEN_KEY); }
  function getTrmnlKey()     { return localStorage.getItem(GH_API_KEY) || ''; }
  function saveTrmnlKey(k)   { k ? localStorage.setItem(GH_API_KEY, k) : localStorage.removeItem(GH_API_KEY); }
  function getConfigRepo()    { return localStorage.getItem(GH_CONFIG_REPO_KEY) || ''; }
  function saveConfigRepo(r)  { r ? localStorage.setItem(GH_CONFIG_REPO_KEY, r) : localStorage.removeItem(GH_CONFIG_REPO_KEY); }
  function effectiveRepo(cfg) { return (cfg && cfg.repo) || ''; }

  // Returns {owner, repo, branch} for where .trmnl-sync.json lives.
  // If a dedicated config repo is set, use that (always on main).
  // Otherwise fall back to the per-plugin repo + branch.
  function configRepoCoords(perPluginOwner, perPluginRepo, perPluginBranch) {
    const cr = getConfigRepo().trim();
    if (cr && cr.includes('/')) {
      const [o, r] = cr.split('/');
      return { owner: o, repo: r, branch: 'main' };
    }
    return { owner: perPluginOwner, repo: perPluginRepo, branch: perPluginBranch };
  }

  function resolvePath(template, pluginId) {
    return template.replace(/\{id\}/g, pluginId).replace(/\/+$/, '');
  }

  // Extract the plugin name from settings.yml content (most reliable source).
  function extractNameFromYaml(yaml) {
    const m = (yaml || '').match(/^name:\s*["']?(.+?)["']?\s*$/m);
    return m ? m[1].trim() : null;
  }

  function resolveMsg(template, pluginId, nameOverride) {
    const name = nameOverride || getPluginName() || `plugin ${pluginId}`;
    return template.replace(/\{id\}/g, pluginId).replace(/\{name\}/g, name);
  }

  // Accepts a full GitHub URL or bare "owner/repo" and returns "owner/repo"
  function normalizeRepoInput(raw) {
    let s = raw.trim();
    // git@github.com:owner/repo.git
    s = s.replace(/^git@github\.com:/, '');
    // https://github.com/owner/repo[.git][/]
    s = s.replace(/^https?:\/\/github\.com\//, '');
    // strip trailing .git or /
    s = s.replace(/\.git$/, '').replace(/\/$/, '');
    return s;
  }

  function parseRepo(cfg) {
    const parts = effectiveRepo(cfg).trim().split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      throw new Error('Set a repository in the GitHub Sync panel.');
    }
    return { owner: parts[0], repo: parts[1] };
  }

  // ---------------------------------------------------------------------------
  // Auto-push on save
  // ---------------------------------------------------------------------------

  function attachAutoSave(pluginId) {
    const form =
      document.querySelector('form[id^="edit_plugin_setting"]') ||
      document.querySelector('[data-markup-target="enabledSaveButton"]')?.closest('form');
    if (!form || form.dataset.ghSyncAttached) return;
    form.dataset.ghSyncAttached = 'true';

    form.addEventListener('submit', () => {
      if (!getConfig(pluginId).autoPush) return;
      sessionStorage.setItem(AUTOPUSH_KEY, pluginId);
      log('Auto-push flagged for after reload');
    });
  }

  async function checkAutoPush() {
    const pendingId = sessionStorage.getItem(AUTOPUSH_KEY);
    if (!pendingId) return;
    sessionStorage.removeItem(AUTOPUSH_KEY);
    if (getPluginId() !== pendingId) return;
    if (!getConfig(pendingId).autoPush) return;

    log('Auto-push triggered for plugin', pendingId);
    try {
      // Small delay to let TRMNL finish updating the archive after page reload
      await new Promise(r => setTimeout(r, 1500));
      const url = await push(pendingId, msg => log(msg));
      log('Auto-push complete:', url);
      // Hide pull/push indicators — GitHub API caches for minutes so re-querying
      // immediately would return stale SHAs and falsely show the pull button.
      document.getElementById(PULL_BTN_ID)?.style.setProperty('display', 'none');
      document.getElementById(PUSH_BTN_ID)?.style.setProperty('display', 'none');
    } catch (e) {
      warn('Auto-push failed:', e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Last-push SHA tracking (for pull indicator)
  // ---------------------------------------------------------------------------

  function lastPushShasKey(pluginId)  { return `${LAST_PUSH_SHAS_KEY}_${pluginId}`; }
  function lastPushTimeKey(pluginId)  { return `${LAST_PUSH_TIME_KEY}_${pluginId}`; }
  function getLastPushShas(pluginId) {
    try { return JSON.parse(localStorage.getItem(lastPushShasKey(pluginId)) || '{}'); } catch { return {}; }
  }
  function setLastPushShas(pluginId, shas) {
    localStorage.setItem(lastPushShasKey(pluginId), JSON.stringify(shas));
  }
  function recordPushTime(pluginId) {
    localStorage.setItem(lastPushTimeKey(pluginId), Date.now().toString());
  }
  // How many ms since the last push (Infinity if never pushed)
  function pushAgeMs(pluginId) {
    const t = localStorage.getItem(lastPushTimeKey(pluginId));
    return t ? Date.now() - parseInt(t, 10) : Infinity;
  }
  // GitHub Contents API caches directory listings for several minutes after a
  // push via the Git Trees API. Skip the pull-indicator check during that window.
  const PUSH_GRACE_MS = 6 * 60 * 1000;

  // ---------------------------------------------------------------------------
  // Diff helpers (ported from editor-backups, using gh-diff-* CSS prefix)
  // ---------------------------------------------------------------------------

  function diffLines(a, b) {
    const aL = a ? a.replace(/\r/g, '').split('\n') : [];
    const bL = b ? b.replace(/\r/g, '').split('\n') : [];
    const m  = Math.min(aL.length, 800);
    const n  = Math.min(bL.length, 800);
    const dp = Array.from({ length: m + 1 }, () => new Int16Array(n + 1));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = aL[i] === bL[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
    const out = [];
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && aL[i] === bL[j]) { out.push({ t: 'eq',  l: aL[i] }); i++; j++; }
      else if (i < m && (j >= n || dp[i+1][j] >= dp[i][j+1])) { out.push({ t: 'del', l: aL[i] }); i++; }
      else { out.push({ t: 'add', l: bL[j] }); j++; }
    }
    return out;
  }

  const chevronUp   = `<svg width="10" height="10" viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,165.66a8,8,0,0,1-11.32,0L128,91.31,53.66,165.66A8,8,0,0,1,42.34,154.34l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,213.66,165.66Z"/></svg>`;
  const chevronDown = `<svg width="10" height="10" viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>`;

  function ghBuildDiffEl(oldText, newText) {
    if (oldText === newText) {
      const p = mk('p', 'text-xs text-gray-500 dark:text-gray-400 italic py-1');
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

    const pre = mk('pre', 'gh-diff');
    let lastShown = -1;
    const rendered = new Uint8Array(diff.length);

    function appendIntraLine(row, marker, line, other, hlCls) {
      let p = 0;
      while (p < line.length && p < other.length && line[p] === other[p]) p++;
      let lEnd = line.length, oEnd = other.length;
      while (lEnd > p && oEnd > p && line[lEnd-1] === other[oEnd-1]) { lEnd--; oEnd--; }
      row.appendChild(document.createTextNode(marker + line.slice(0, p)));
      if (lEnd > p) row.appendChild(mk('mark', hlCls, line.slice(p, lEnd)));
      if (lEnd < line.length) row.appendChild(document.createTextNode(line.slice(lEnd)));
    }

    diff.forEach((d, idx) => {
      if (!show[idx] || rendered[idx]) return;
      if (lastShown !== -1 && idx > lastShown + 1) pre.appendChild(mk('div', 'gh-diff-skip', '···'));
      if (d.t === 'del') {
        let k = idx;
        const dels = [], adds = [];
        while (k < diff.length && diff[k].t === 'del' && !rendered[k]) dels.push(k++);
        while (k < diff.length && diff[k].t === 'add' && !rendered[k]) adds.push(k++);
        dels.forEach(i => rendered[i] = 1);
        adds.forEach(i => rendered[i] = 1);
        const pairs = Math.min(dels.length, adds.length);
        for (let p = 0; p < pairs; p++) {
          const ol = diff[dels[p]].l, nl = diff[adds[p]].l;
          const dr = mk('div', 'gh-diff-del'); appendIntraLine(dr, '− ', ol, nl, 'gh-hl-del'); pre.appendChild(dr);
          const ar = mk('div', 'gh-diff-add'); appendIntraLine(ar, '+ ', nl, ol, 'gh-hl-add'); pre.appendChild(ar);
        }
        for (let p = pairs; p < dels.length; p++) {
          const row = mk('div', 'gh-diff-del'); row.textContent = '− ' + diff[dels[p]].l; pre.appendChild(row);
        }
        for (let p = pairs; p < adds.length; p++) {
          const row = mk('div', 'gh-diff-add'); row.textContent = '+ ' + diff[adds[p]].l; pre.appendChild(row);
        }
        lastShown = k - 1;
      } else {
        const row = mk('div', `gh-diff-${d.t}`);
        row.textContent = (d.t === 'add' ? '+ ' : '  ') + d.l;
        pre.appendChild(row);
        lastShown = idx;
      }
    });

    // Use a clipDiv to control vertical clipping — avoids the CSS overflow-x/y
    // interaction bug where setting overflow-y:visible is silently overridden by
    // the browser when overflow-x is already auto on the same element.
    let expanded = false;
    const clipDiv = mk('div', '');
    clipDiv.style.overflow  = 'hidden';
    clipDiv.style.maxHeight = '10rem';
    clipDiv.appendChild(pre);

    const expandBtn = mk('button',
      'w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium ' +
      'text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 ' +
      'border-t border-gray-200 dark:border-gray-700 cursor-pointer ' +
      'bg-gray-50 dark:bg-gray-800 transition-colors'
    );
    expandBtn.type = 'button';
    expandBtn.innerHTML = `${chevronDown}<span>Show full diff</span>`;
    expandBtn.addEventListener('click', e => {
      e.stopPropagation();
      expanded = !expanded;
      clipDiv.style.maxHeight = expanded ? 'none' : '10rem';
      expandBtn.innerHTML = expanded
        ? `${chevronUp}<span>Collapse</span>`
        : `${chevronDown}<span>Show full diff</span>`;
    });

    const wrap = mk('div', 'rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden mt-1');
    wrap.append(clipDiv, expandBtn);
    return wrap;
  }

  // Render a GitHub unified-diff patch string (from commits API files[].patch)
  // into the same styled <pre> element as ghBuildDiffEl.
  function renderPatch(patch) {
    const pre = mk('pre', 'gh-diff');
    if (!patch) { pre.textContent = '(binary or empty)'; return pre; }
    for (const line of patch.split('\n')) {
      let cls = 'gh-diff-eq';
      if (line.startsWith('@@'))       cls = 'gh-diff-skip';
      else if (line.startsWith('+'))   cls = 'gh-diff-add';
      else if (line.startsWith('-'))   cls = 'gh-diff-del';
      const row = mk('div', cls);
      row.textContent = line;
      pre.appendChild(row);
    }
    const wrap = mk('div', 'rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden mt-1');
    const clip = mk('div', '');
    clip.style.overflow  = 'hidden';
    clip.style.maxHeight = '12rem';
    clip.appendChild(pre);
    const btn = mk('button',
      'w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium ' +
      'text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 ' +
      'border-t border-gray-200 dark:border-gray-700 cursor-pointer ' +
      'bg-gray-50 dark:bg-gray-800 transition-colors'
    );
    btn.type = 'button';
    btn.innerHTML = `${chevronDown}<span>Show full diff</span>`;
    let expanded = false;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      expanded = !expanded;
      clip.style.maxHeight = expanded ? 'none' : '12rem';
      btn.innerHTML = expanded
        ? `${chevronUp}<span>Collapse</span>`
        : `${chevronDown}<span>Show full diff</span>`;
    });
    wrap.append(clip, btn);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // GitHub API
  // ---------------------------------------------------------------------------

  async function ghFetch(path, opts = {}) {
    const token = getToken();
    if (!token) throw new Error('GitHub token not configured. Open the GitHub Sync panel to set it.');
    const res = await fetch(`https://api.github.com${path}`, {
      cache: 'no-store',
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {}),
      },
    });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${body.message || res.statusText}`);
    return body;
  }

  // Check if a repo exists and is accessible.
  // Returns { error: string|null, isPublic: bool }.
  async function ghCheckRepo(owner, repo) {
    try {
      const data = await ghFetch(`/repos/${owner}/${repo}`);
      return { error: null, isPublic: data.private === false };
    } catch (e) {
      if (e.message.includes('404')) return { error: `Repository "${owner}/${repo}" not found or not accessible.`, isPublic: false };
      if (e.message.includes('401') || e.message.includes('403')) return { error: `No access to "${owner}/${repo}" — check your token permissions.`, isPublic: false };
      return { error: e.message, isPublic: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Remote config: read/write .trmnl-sync.json at the repo root
  // Keys stored: branch, path, commitMsg, autoPush  (repo + tokens stay local)
  // ---------------------------------------------------------------------------

  // Returns the full parsed .trmnl-sync.json object, or null if not found.
  async function loadAllRemoteConfig(owner, repo, branch) {
    const c = configRepoCoords(owner, repo, branch);
    try {
      const data = await ghFetch(
        `/repos/${c.owner}/${c.repo}/contents/${REMOTE_CONFIG_FILE}?ref=${encodeURIComponent(c.branch)}`
      );
      const parsed = JSON.parse(b64ToUtf8(data.content));
      return parsed;
    } catch (e) {
      if (e.message.includes('404')) return null;
      throw e;
    }
  }

  // Write a full config data object to the localStorage cache.
  // The GitHub config repo is the source of truth; this is only a local cache
  // so that non-panel operations (push, pull, auto-push) don't need a network round-trip.
  function cacheConfigData(data) {
    const g = data['_global'] || {};
    if (g.ghToken)      saveToken(g.ghToken);
    if (g.trmnlApiKey)  saveTrmnlKey(g.trmnlApiKey);
    if (g.configRepo)   saveConfigRepo(g.configRepo);
    for (const [id, pc] of Object.entries(data)) {
      if (id === '_global' || !pc || typeof pc !== 'object') continue;
      saveConfig(id, { ...DEFAULT_CONFIG, ...pc });
    }
  }

  // Serialise all remote config writes in the same tab so they never race.
  let _configSaveLock = Promise.resolve();

  async function saveRemoteConfig(owner, repo, branch, pluginId, cfg) {
    const result = _configSaveLock.then(() => _doSaveRemoteConfig(owner, repo, branch, pluginId, cfg));
    _configSaveLock = result.catch(() => {});
    return result;
  }

  async function _doSaveRemoteConfig(owner, repo, branch, pluginId, cfg, retries = 3) {
    const c = configRepoCoords(owner, repo, branch);
    let existingSha;
    let all = {};

    // Always GET the current file so the SHA is fresh — eliminates stale-SHA 409s
    // regardless of how many tabs or how quickly the user saves.
    try {
      const data = await ghFetch(
        `/repos/${c.owner}/${c.repo}/contents/${REMOTE_CONFIG_FILE}?ref=${encodeURIComponent(c.branch)}`
      );
      existingSha = data.sha;
      all = JSON.parse(b64ToUtf8(data.content));
    } catch (e) {
      if (!e.message.includes('404')) throw e;
      // File doesn't exist yet — first-time setup, create from scratch.
    }

    all['_global'] = { ghToken: getToken(), trmnlApiKey: getTrmnlKey(), configRepo: getConfigRepo() };
    // Store the full config including repo so other PCs can restore it from the config file.
    // Omit empty-string repo to avoid poisoning the file with blank entries that would
    // overwrite a valid repo on another PC when the file is loaded back.
    const stored = { ...cfg };
    if (!stored.repo) delete stored.repo;
    all[pluginId] = stored;

    const json    = JSON.stringify(all, null, 2) + '\n';
    const content = btoa(unescape(encodeURIComponent(json)));
    const body    = { message: 'chore: update TRMNL sync config', content, branch: c.branch };
    if (existingSha) body.sha = existingSha;

    try {
      await ghFetch(`/repos/${c.owner}/${c.repo}/contents/${REMOTE_CONFIG_FILE}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
    } catch (e) {
      if (retries > 0 && e.message.includes('409')) {
        // Concurrent write from another tab/device — back off and retry with fresh GET.
        await new Promise(r => setTimeout(r, 300 * (4 - retries))); // 300 / 600 / 900 ms
        return _doSaveRemoteConfig(owner, repo, branch, pluginId, cfg, retries - 1);
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // TRMNL archive helpers
  // ---------------------------------------------------------------------------

  async function fetchArchive(pluginId) {
    const res = await fetch(`https://trmnl.com/api/plugin_settings/${pluginId}/archive`);
    if (!res.ok) throw new Error(`TRMNL archive fetch failed: ${res.status}`);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const files = {};
    await Promise.all(
      Object.entries(zip.files)
        .filter(([, e]) => !e.dir)
        .map(async ([name, e]) => { files[name] = await e.async('text'); })
    );
    return files;
  }

  async function buildAndUpload(pluginId, files) {
    const key = getTrmnlKey();
    if (!key) throw new Error('TRMNL API key not set. Configure it in the GitHub Sync panel.');
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
      if (content != null) zip.file(name, content);
    }
    const raw  = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const blob = new Blob([raw], { type: 'application/zip' });
    const fd   = new FormData();
    fd.append('file', blob, 'archive.zip');
    const res = await fetch(`https://trmnl.com/api/plugin_settings/${pluginId}/archive`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TRMNL upload ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
    }
  }

  // Normalize line endings to \n (GitHub always stores with \n).
  // TRMNL's archive may return \r\n, causing false SHA mismatches.
  function normalizeLF(s) { return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }

  // Compute the git blob SHA that GitHub uses, so we can diff without downloading file content.
  // Formula: SHA1("blob " + byteLength + "\0" + content)
  async function gitBlobSha(content) {
    const enc    = new TextEncoder();
    const body   = enc.encode(normalizeLF(content));
    const header = enc.encode(`blob ${body.length}\0`);
    const buf    = new Uint8Array(header.length + body.length);
    buf.set(header);
    buf.set(body, header.length);
    const digest = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------------------------------------------------------------------------
  // Push: TRMNL → GitHub
  //
  // Uses the Git Trees API to produce a single atomic commit for all files.
  // ---------------------------------------------------------------------------

  async function push(pluginId, onLog) {
    const cfg = getConfig(pluginId);
    const { owner, repo } = parseRepo(cfg);
    const branch   = cfg.branch.trim() || 'main';
    const basePath = resolvePath(cfg.path, pluginId);

    onLog('Fetching TRMNL archive…');
    const files = await fetchArchive(pluginId);
    const names = Object.keys(files);
    if (!names.length) throw new Error('Plugin archive is empty.');
    onLog(`${names.length} files: ${names.join(', ')}`);

    // Use name from settings.yml (reliable across all TRMNL pages)
    const pluginName = extractNameFromYaml(files['settings.yml'] || files['settings.yaml'] || '');
    const message    = resolveMsg(cfg.commitMsg, pluginId, pluginName);

    // ── Change detection: compare git blob SHAs with what GitHub already has ──
    onLog('Checking for changes…');
    let currentShas = {};
    try {
      const dir = await ghFetch(
        `/repos/${owner}/${repo}/contents/${basePath}?ref=${encodeURIComponent(branch)}`
      );
      if (Array.isArray(dir)) {
        for (const f of dir) { if (f.type === 'file') currentShas[f.name] = f.sha; }
      }
    } catch (e) {
      if (!e.message.includes('404') && !e.message.includes('409')) throw e;
      // 404 = path doesn't exist yet; 409 = repo is empty — treat both as first push (all-new)
    }
    const trmnlShas = Object.fromEntries(
      await Promise.all(names.map(async n => [n, await gitBlobSha(files[n])]))
    );
    const changed = names.filter(n => trmnlShas[n] !== currentShas[n]);
    const deleted = Object.keys(currentShas).filter(n => !files[n]);
    if (!changed.length && !deleted.length) {
      onLog('Nothing to commit — plugin already matches GitHub.');
      return null;
    }
    onLog(`Changes: ${[...changed, ...deleted.map(n => `${n} (deleted)`)].join(', ')}`);

    onLog(`Reading branch "${branch}"…`);
    let headSha    = null;
    let baseTree   = null;
    let repoIsEmpty = false;
    try {
      const refData    = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      headSha          = refData.object.sha;
      const headCommit = await ghFetch(`/repos/${owner}/${repo}/git/commits/${headSha}`);
      baseTree         = headCommit.tree.sha;
    } catch (e) {
      if (e.message.includes('409')) {
        repoIsEmpty = true; // Git Data API unavailable until repo has at least one commit
        onLog('Repository is empty — will initialize via Contents API.');
      } else if (e.message.includes('404')) {
        onLog(`Branch "${branch}" not found — will create it on first push.`);
      } else {
        throw e;
      }
    }

    // ── Empty repo: Git Data API (blobs/trees/commits) returns 409 on repos with no commits.
    // Use the Contents API instead — it works on empty repos and initializes the branch.
    // This creates one commit per file; subsequent pushes use the efficient Data API path.
    if (repoIsEmpty) {
      onLog('Initializing repository…');
      const pushedShas = {};
      let lastCommitSha = null;
      for (const name of names) {
        const res = await ghFetch(`/repos/${owner}/${repo}/contents/${basePath}/${name}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            message: name === names[names.length - 1] ? message : `Initialize: add ${name}`,
            content: btoa(unescape(encodeURIComponent(normalizeLF(files[name])))),
            branch,
          }),
        });
        pushedShas[name] = res.content.sha;
        lastCommitSha = res.commit.sha;
      }
      setLastPushShas(pluginId, pushedShas);
      recordPushTime(pluginId);
      onLog(`✓ Pushed ${names.length} files to ${owner}/${repo}/${basePath}`);
      return `https://github.com/${owner}/${repo}/commit/${lastCommitSha}`;
    }

    onLog('Creating blobs…');
    // pushedShas maps filename → the exact SHA GitHub assigns to each blob.
    // These will eventually match what the Contents API directory listing returns,
    // so we store them as our baseline instead of locally-computed SHAs.
    const pushedShas = {};
    const treeItems = await Promise.all(names.map(async name => {
      const blobData = await ghFetch(`/repos/${owner}/${repo}/git/blobs`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content: normalizeLF(files[name]), encoding: 'utf-8' }),
      });
      pushedShas[name] = blobData.sha;
      return { path: `${basePath}/${name}`, mode: '100644', type: 'blob', sha: blobData.sha };
    }));

    onLog('Creating tree…');
    const treePayload = { tree: treeItems };
    if (baseTree) treePayload.base_tree = baseTree; // omit for a brand-new empty repo
    const tree = await ghFetch(`/repos/${owner}/${repo}/git/trees`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(treePayload),
    });

    onLog('Creating commit…');
    const commit = await ghFetch(`/repos/${owner}/${repo}/git/commits`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, tree: tree.sha, parents: headSha ? [headSha] : [] }),
    });

    if (headSha) {
      onLog('Updating branch…');
      await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sha: commit.sha, force: true }),
      });
    } else {
      onLog(`Creating branch "${branch}"…`);
      await ghFetch(`/repos/${owner}/${repo}/git/refs`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      });
    }

    setLastPushShas(pluginId, pushedShas);
    recordPushTime(pluginId);
    onLog(`✓ Pushed ${names.length} files to ${owner}/${repo}/${basePath}`);
    return `https://github.com/${owner}/${repo}/commit/${commit.sha}`;
  }

  // ---------------------------------------------------------------------------
  // Pull: GitHub → TRMNL
  // ---------------------------------------------------------------------------

  async function pull(pluginId, onLog) {
    const cfg = getConfig(pluginId);
    const { owner, repo } = parseRepo(cfg);
    if (!getTrmnlKey()) throw new Error('TRMNL API key not configured. Open the GitHub Sync panel to set it.');
    const branch   = cfg.branch.trim() || 'main';
    const basePath = resolvePath(cfg.path, pluginId);

    onLog(`Fetching file list from ${owner}/${repo}/${basePath}…`);
    let dir;
    try {
      dir = await ghFetch(`/repos/${owner}/${repo}/contents/${basePath}?ref=${encodeURIComponent(branch)}`);
    } catch (e) {
      throw new Error(`Could not read path "${basePath}": ${e.message}`);
    }
    if (!Array.isArray(dir)) throw new Error(`"${basePath}" is not a directory in the repository.`);

    const fileEntries = dir.filter(f => f.type === 'file');
    if (!fileEntries.length) throw new Error(`No files found at "${basePath}".`);
    onLog(`${fileEntries.length} files: ${fileEntries.map(f => f.name).join(', ')}`);

    onLog('Downloading files…');
    const files = {};
    await Promise.all(fileEntries.map(async entry => {
      const data = await ghFetch(
        `/repos/${owner}/${repo}/contents/${entry.path}?ref=${encodeURIComponent(branch)}`
      );
      // GitHub returns base64 content with embedded newlines
      files[entry.name] = b64ToUtf8(data.content);
    }));

    onLog('Uploading to TRMNL…');
    await buildAndUpload(pluginId, files);
    onLog('✓ Pull complete! Redirecting…');

    setTimeout(() => {
      if (window.Turbo?.cache) window.Turbo.cache.clear();
      window.location.href = `https://trmnl.com/plugin_settings/${pluginId}/edit`;
    }, 1200);
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  // Decode a GitHub base64-encoded file content string to a proper UTF-8 string.
  // atob() alone returns a binary (Latin-1) string and corrupts non-ASCII characters.
  function b64ToUtf8(b64) {
    const binary = atob(b64.replace(/\n/g, ''));
    const bytes  = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls)  el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function mkInput(placeholder, value, type = 'text') {
    const el = mk('input',
      'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg ' +
      'bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 ' +
      'focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
    );
    el.type        = type;
    el.placeholder = placeholder;
    el.value       = value;
    el.style.boxSizing = 'border-box';
    return el;
  }

  function mkFieldGroup(labelText) {
    const wrap = mk('div', 'mb-4');
    wrap.appendChild(mk('label', 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1', labelText));
    return wrap;
  }

  function mkSectionHeader(text) {
    return mk('p',
      'text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3',
      text
    );
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  // Repo picker — searchable dropdown of the user's GitHub repos
  async function showRepoPicker(anchorEl, onSelect) {
    const PICKER_ID = 'gh-repo-picker';
    document.getElementById(PICKER_ID)?.remove();

    const picker     = document.createElement('div');
    picker.id        = PICKER_ID;
    picker.className = 'gh-repo-picker';

    const searchIn        = document.createElement('input');
    searchIn.type         = 'text';
    searchIn.placeholder  = 'Search repos…';
    searchIn.className    = 'gh-repo-picker-search';
    searchIn.autocomplete = 'off';

    const list       = document.createElement('div');
    list.className   = 'gh-repo-picker-list';
    list.textContent = 'Loading…';

    picker.append(searchIn, list);

    const rect = anchorEl.getBoundingClientRect();
    const pickerW = Math.max(rect.width, 300);
    const left    = Math.min(rect.left, window.innerWidth - pickerW - 8);
    picker.style.cssText = `position:fixed;left:${Math.max(8, left)}px;top:${rect.bottom + 4}px;` +
      `width:${pickerW}px;z-index:999999;`;
    document.body.appendChild(picker);
    searchIn.focus();

    let repos = [];

    function renderList(items) {
      list.innerHTML = '';
      if (!items.length) { list.textContent = 'No repos found.'; return; }
      items.slice(0, 80).forEach(r => {
        const btn = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'gh-repo-picker-item';
        const nameSpan       = document.createElement('span');
        nameSpan.textContent = r.full_name;
        btn.appendChild(nameSpan);
        if (r.private) {
          const tag       = document.createElement('span');
          tag.className   = 'gh-repo-picker-private';
          tag.textContent = 'private';
          btn.appendChild(tag);
        }
        btn.addEventListener('mousedown', e => {
          e.preventDefault();
          onSelect(r.full_name);
          picker.remove();
        });
        list.appendChild(btn);
      });
    }

    try {
      repos = await ghFetch('/user/repos?per_page=100&sort=updated&type=all');
      renderList(repos);
    } catch(e) {
      list.textContent = 'Error: ' + e.message;
    }

    searchIn.addEventListener('input', () => {
      const q = searchIn.value.toLowerCase();
      renderList(repos.filter(r => r.full_name.toLowerCase().includes(q)));
    });

    function onOutsideClick(e) {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('mousedown', onOutsideClick);
      }
    }
    setTimeout(() => document.addEventListener('mousedown', onOutsideClick), 0);
  }

  // remoteCfg: the per-plugin object read directly from the GitHub config repo.
  // When present it is the source of truth; localStorage is only the fallback cache.
  function buildPanel(pluginId, remoteCfg = null) {
    const overlay = mk('div', '');
    overlay.id = OVERLAY_ID;
    overlay.addEventListener('click', closePanel);

    const panel = mk('div', '');
    panel.id = PANEL_ID;

    // ── Header ────────────────────────────────────────────────────────────────
    const hdr = mk('div',
      'flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0'
    );
    const iconBtnCls =
      'w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 ' +
      'hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';

    const closeBtn = mk('button', iconBtnCls, '✕');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closePanel);

    const title = mk('div', 'flex items-center gap-2');
    title.innerHTML = ghIcon(15);
    title.appendChild(mk('span', 'text-sm font-semibold text-gray-900 dark:text-gray-100', 'GitHub Sync'));

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

    const hdrBtns = mk('div', 'flex items-center gap-1 ml-auto');
    hdrBtns.append(expandPanelBtn, closeBtn);
    hdr.append(title, hdrBtns);
    panel.appendChild(hdr);

    // ── Scrollable body ───────────────────────────────────────────────────────
    const scroll = mk('div', 'flex-1 overflow-y-auto');

    // ── Shared helper: chip+Change / Not set+Set pattern for secret fields ────
    function mkSecretSection(sectionTitle, currentValue, placeholder, hint, saveFn) {
      const sec = mk('div', 'px-5 py-4 border-b border-gray-200 dark:border-gray-700');
      sec.appendChild(mkSectionHeader(sectionTitle));

      const chipSetCls   = 'gh-chip-set';
      const chipUnsetCls = 'gh-chip-unset';
      const linkBtnCls = 'gh-link-btn';
      const primaryBtnCls =
        'cursor-pointer font-medium rounded-lg text-xs px-3 py-1.5 inline-flex items-center ' +
        'transition duration-150 gap-1.5 border-0 ' +
        'text-white bg-primary-500 dark:bg-primary-600 hover:bg-primary-600 dark:hover:bg-primary-500';

      const row = mk('div', 'flex items-center gap-2 flex-wrap');
      const inputWrap = mk('div', 'w-full mt-2 hidden');
      const inp = mkInput(placeholder, currentValue, 'password');
      inputWrap.appendChild(inp);

      if (currentValue) {
        const chip      = mk('span', chipSetCls, '✓ Saved');
        const changeBtn = mk('button', linkBtnCls, 'Change');
        changeBtn.type  = 'button';
        changeBtn.style.setProperty('background', 'none', 'important');
        changeBtn.addEventListener('click', () => {
          inputWrap.classList.toggle('hidden');
          if (!inputWrap.classList.contains('hidden')) inp.focus();
        });
        inp.addEventListener('change', () => {
          const v = inp.value.trim();
          saveFn(v);
          chip.textContent = v ? '✓ Saved' : 'Cleared — reload panel';
        });
        row.append(chip, changeBtn);
      } else {
        const chip   = mk('span', chipUnsetCls, 'Not set');
        const setBtn = mk('button', primaryBtnCls, 'Set');
        setBtn.type  = 'button';
        setBtn.addEventListener('click', () => {
          inputWrap.classList.toggle('hidden');
          if (!inputWrap.classList.contains('hidden')) inp.focus();
        });
        const saveBtn = mk('button', primaryBtnCls, 'Save');
        saveBtn.type  = 'button';
        saveBtn.addEventListener('click', () => {
          const v = inp.value.trim();
          if (!v) return;
          saveFn(v);
          chip.className   = chipSetCls;
          chip.textContent = '✓ Saved';
          inputWrap.classList.add('hidden');
        });
        inputWrap.appendChild(saveBtn);
        row.append(chip, setBtn);
      }

      sec.append(row, inputWrap);
      if (hint) sec.appendChild(hint);
      return sec;
    }

    // ── Global Setup (collapsible) ────────────────────────────────────────────
    function isGlobalConfigured() {
      return !!(getToken() && getTrmnlKey() && getConfigRepo());
    }

    const globalSec  = mk('div', 'border-b border-gray-200 dark:border-gray-700 flex-shrink-0');
    const globalHdr  = mk('div',
      'gh-global-hdr flex items-center justify-between px-5 py-3 cursor-pointer select-none ' +
      'hover:bg-gray-50 transition-colors'
    );
    const globalArrow = mk('span', 'text-gray-500 dark:text-gray-400 text-xs mr-2', isGlobalConfigured() ? '▸' : '▾');
    const globalTitleRow = mk('div', 'flex items-center');
    globalTitleRow.append(globalArrow, mk('span',
      'text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400', 'Global Setup'
    ));
    const globalChip = mk('span', isGlobalConfigured() ? 'gh-chip-set' : 'gh-chip-unset',
      isGlobalConfigured() ? '✓ Ready' : 'Setup required'
    );
    globalHdr.append(globalTitleRow, globalChip);

    const globalBody = mk('div', 'px-5 pb-5 pt-3 space-y-4');
    globalBody.style.display = isGlobalConfigured() ? 'none' : '';

    globalHdr.addEventListener('click', () => {
      const open = globalBody.style.display !== 'none';
      globalBody.style.display = open ? 'none' : '';
      globalArrow.textContent  = open ? '▸' : '▾';
    });

    function updateGlobalChip() {
      const ok = isGlobalConfigured();
      globalChip.className   = ok ? 'gh-chip-set' : 'gh-chip-unset';
      globalChip.textContent = ok ? '✓ Ready' : 'Setup required';
      if (ok) {
        globalBody.style.display = 'none';
        globalArrow.textContent  = '▸';
      }
    }

    // Compact key field used inside the global section
    function mkKeyField(currentValue, placeholder, onSave) {
      const wrap     = mk('div', '');
      const inputWrap = mk('div', 'mt-1.5 hidden');
      const inp      = mkInput(placeholder, currentValue, 'password');
      inputWrap.appendChild(inp);
      const row = mk('div', 'flex items-center gap-2');
      if (currentValue) {
        const chip = mk('span', 'gh-chip-set', '✓ Saved');
        const changeBtn = mk('button', 'gh-link-btn', 'Change');
        changeBtn.type = 'button';
        changeBtn.style.setProperty('background', 'none', 'important');
        changeBtn.addEventListener('click', () => {
          inputWrap.classList.toggle('hidden');
          if (!inputWrap.classList.contains('hidden')) inp.focus();
        });
        inp.addEventListener('change', () => { onSave(inp.value.trim()); updateGlobalChip(); });
        row.append(chip, changeBtn);
      } else {
        const chip    = mk('span', 'gh-chip-unset', 'Not set');
        const setBtn  = mk('button', 'gh-link-btn', 'Set');
        setBtn.type   = 'button';
        setBtn.style.setProperty('background', 'none', 'important');
        const saveBtn = mk('button',
          'mt-1.5 cursor-pointer font-medium rounded-lg text-xs px-3 py-1.5 inline-flex ' +
          'items-center transition duration-150 border-0 ' +
          'text-white bg-primary-500 dark:bg-primary-600 hover:bg-primary-600', 'Save'
        );
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', () => {
          const v = inp.value.trim(); if (!v) return;
          onSave(v);
          chip.className = 'gh-chip-set'; chip.textContent = '✓ Saved';
          inputWrap.classList.add('hidden'); updateGlobalChip();
        });
        setBtn.addEventListener('click', () => {
          inputWrap.classList.toggle('hidden');
          if (!inputWrap.classList.contains('hidden')) inp.focus();
        });
        inputWrap.appendChild(saveBtn);
        row.append(chip, setBtn);
      }
      wrap.append(row, inputWrap);
      return wrap;
    }

    // GitHub token
    const tokenFieldWrap = mk('div', '');
    tokenFieldWrap.appendChild(mk('p', 'text-xs font-medium text-gray-600 dark:text-gray-400 mb-1', 'GitHub Token'));
    tokenFieldWrap.appendChild(mkKeyField(getToken(), 'ghp_xxxxxxxxxxxx', saveToken));
    const tokenHint = mk('p', 'text-xs text-gray-500 dark:text-gray-400 mt-1');
    tokenHint.innerHTML = 'Needs "repo" scope. <a href="https://github.com/settings/tokens/new?scopes=repo&description=TRMNL+GitHub+Sync" target="_blank" rel="noopener noreferrer" style="color:#3b82f6;text-decoration:underline;">Create one</a>.';
    tokenFieldWrap.appendChild(tokenHint);
    globalBody.appendChild(tokenFieldWrap);

    // Config repo
    const cfgRepoWrap    = mk('div', '');
    const cfgRepoStatus  = mk('p', 'text-xs mt-1');
    const cfgRepoWarning = mk('div',
      'hidden mt-2 px-3 py-2 rounded-lg border border-red-400 bg-red-50 dark:bg-red-950/50 dark:border-red-700 text-red-700 dark:text-red-300 text-xs font-medium'
    );
    cfgRepoWarning.innerHTML =
      '⚠ <strong>This repository is PUBLIC.</strong> Your GitHub token and TRMNL API key are exposed to the world. ' +
      '<strong>Delete or revoke them immediately</strong>, then recreate this repo as private.';
    const cfgRepoIn     = mkInput('https://github.com/you/trmnl-github-sync', getConfigRepo());
    cfgRepoWrap.appendChild(mk('p', 'text-xs font-medium text-gray-600 dark:text-gray-400 mb-1', 'Config repository'));
    cfgRepoWrap.append(cfgRepoIn, cfgRepoStatus, cfgRepoWarning);
    globalBody.appendChild(cfgRepoWrap);

    // TRMNL API key
    const trmnlFieldWrap = mk('div', '');
    trmnlFieldWrap.appendChild(mk('p', 'text-xs font-medium text-gray-600 dark:text-gray-400 mb-1', 'TRMNL User API Key'));
    trmnlFieldWrap.appendChild(mkKeyField(getTrmnlKey(), 'user_xxxxx', saveTrmnlKey));
    trmnlFieldWrap.appendChild(mk('p', 'text-xs text-gray-500 dark:text-gray-400 mt-1',
      'Required for Pull from GitHub. Found on your account page.'));
    globalBody.appendChild(trmnlFieldWrap);

    // Paste-to-bootstrap
    const pasteSec    = mk('div', 'border-t border-gray-100 dark:border-gray-700/60 pt-3');
    const pasteToggle = mk('button', 'gh-link-btn flex items-center gap-1 text-xs', '▸ Set up on another PC — paste config');
    pasteToggle.type  = 'button';
    pasteToggle.style.setProperty('background', 'none', 'important');
    const pasteBody   = mk('div', 'mt-2 hidden');
    const pasteArea   = mk('textarea',
      'w-full h-28 px-3 py-2 text-xs font-mono border border-gray-300 dark:border-gray-600 rounded-lg ' +
      'bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 resize-none'
    );
    pasteArea.placeholder = 'Paste the contents of .trmnl-sync.json here…';
    pasteArea.style.boxSizing = 'border-box';
    const pasteApplyBtn = mk('button',
      'mt-2 cursor-pointer font-medium rounded-lg text-xs px-3 py-1.5 inline-flex items-center ' +
      'transition duration-150 border-0 text-white bg-primary-500 hover:bg-primary-600', 'Apply'
    );
    pasteApplyBtn.type = 'button';
    const pasteStatus  = mk('p', 'text-xs mt-1');
    pasteApplyBtn.addEventListener('click', () => {
      try {
        const data = JSON.parse(pasteArea.value.trim());
        // Cache credentials + all plugin configs locally, then reopen.
        // openPanel will re-fetch from GitHub (using the now-cached token + configRepo)
        // and buildPanel will render from that authoritative source.
        cacheConfigData(data);
        pasteStatus.textContent = '✓ Applied! Reopening panel…';
        pasteStatus.style.color = '#16a34a';
        setTimeout(() => { closePanel(); openPanel(); }, 800);
      } catch (e) {
        pasteStatus.textContent = `Error: ${e.message}`;
        pasteStatus.style.color = '#dc2626';
      }
    });
    pasteToggle.addEventListener('click', () => {
      const hidden = pasteBody.classList.toggle('hidden');
      pasteToggle.textContent = (hidden ? '▸' : '▾') + ' Set up on another PC — paste config';
      pasteToggle.style.setProperty('background', 'none', 'important');
    });
    pasteBody.append(pasteArea, pasteApplyBtn, pasteStatus);
    pasteSec.append(pasteToggle, pasteBody);
    globalBody.appendChild(pasteSec);

    // Reset all local storage
    const resetSec = mk('div', 'border-t border-gray-100 dark:border-gray-700/60 pt-3');
    const resetBtn = mk('button',
      'gh-link-btn flex items-center gap-1 text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300',
      '⚠ Reset all local data'
    );
    resetBtn.type = 'button';
    resetBtn.style.setProperty('background', 'none', 'important');
    const resetStatus = mk('p', 'text-xs mt-1');
    resetBtn.addEventListener('click', () => {
      if (!confirm('Clear all GitHub Sync data from this browser? This removes your token, API key, config repo, and all cached plugin configs. The .trmnl-sync.json on GitHub is not affected.')) return;
      const keys = Object.keys(localStorage).filter(k => k.startsWith('trmnl_gh'));
      keys.forEach(k => localStorage.removeItem(k));
      resetStatus.className   = 'text-xs mt-1 text-green-600 dark:text-green-400';
      resetStatus.textContent = `✓ Cleared ${keys.length} item(s). Closing panel…`;
      setTimeout(() => closePanel(), 1200);
    });
    resetSec.append(resetBtn, resetStatus);
    globalBody.appendChild(resetSec);

    // Config repo validation + optional auto-load
    // triggerLoad=false on initial render because openPanel already pre-fetched
    let cfgRepoTimer;
    function validateCfgRepo(raw, triggerLoad = true) {
      const normalized = raw.trim() ? normalizeRepoInput(raw) : '';
      const parts = normalized.split('/');
      const valid = !normalized || (parts.length === 2 && !!parts[0] && !!parts[1]);
      if (!normalized) {
        cfgRepoStatus.className = 'text-xs mt-1 text-gray-500 dark:text-gray-400';
        cfgRepoStatus.innerHTML =
          'Where <code>.trmnl-sync.json</code> lives. Recommended: create a private ' +
          '<a href="https://github.com/new?name=trmnl-github-sync&visibility=private" target="_blank" ' +
          'rel="noopener noreferrer" style="color:#3b82f6;text-decoration:underline;">trmnl-github-sync</a> repo.';
      } else {
        cfgRepoStatus.className = valid ? 'gh-repo-ok' : 'gh-repo-err';
        cfgRepoStatus.textContent = valid ? `✓ ${normalized}` : 'Use "owner/repo" or paste a GitHub URL.';
      }
      if (valid && normalized) {
        cfgRepoIn.value = normalized;
        saveConfigRepo(normalized);
        updateGlobalChip();
        if (triggerLoad) {
          clearTimeout(cfgRepoTimer);
          cfgRepoTimer = setTimeout(async () => {
            if (getToken()) {
              cfgRepoStatus.className   = 'text-xs mt-1 text-gray-500 dark:text-gray-400 italic';
              cfgRepoStatus.textContent = 'Checking repository…';
              const [o, r] = normalized.split('/');
              const { error, isPublic } = await ghCheckRepo(o, r);
              cfgRepoWarning.classList.toggle('hidden', !isPublic);
              if (error) {
                cfgRepoStatus.className   = 'gh-repo-err';
                cfgRepoStatus.textContent = error;
                return;
              }
            }
            reloadFromConfigRepo(normalized);
          }, 600);
        }
      }
    }

    // When the user changes the config repo field, reload the panel from scratch
    // so openPanel pre-fetches from the new repo and buildPanel gets fresh data.
    async function reloadFromConfigRepo(repoStr) {
      if (!getToken()) return;
      cfgRepoStatus.className   = 'text-xs mt-1 text-gray-500 dark:text-gray-400 italic';
      cfgRepoStatus.textContent = 'Loading from GitHub…';
      try {
        const [o, r] = repoStr.split('/');
        const { error, isPublic } = await ghCheckRepo(o, r);
        cfgRepoWarning.classList.toggle('hidden', !isPublic);
        if (error) { cfgRepoStatus.className = 'gh-repo-err'; cfgRepoStatus.textContent = error; return; }
        cfgRepoStatus.className   = 'gh-repo-ok';
        cfgRepoStatus.textContent = `✓ ${repoStr}`;
      } catch (e) {
        cfgRepoStatus.className   = 'gh-repo-err';
        cfgRepoStatus.textContent = `Could not reach repo: ${e.message}`;
        return;
      }
      // Reopen panel — openPanel will fetch from the new configRepo and pass
      // the remote data directly to buildPanel as the source of truth.
      setTimeout(() => { closePanel(); openPanel(); }, 400);
    }

    validateCfgRepo(getConfigRepo(), false); // show initial state only — openPanel pre-fetched
    // Silently check visibility on open so the warning shows for an already-configured repo
    if (getToken() && getConfigRepo()) {
      const [_o, _r] = getConfigRepo().split('/');
      ghCheckRepo(_o, _r).then(({ isPublic }) => cfgRepoWarning.classList.toggle('hidden', !isPublic));
    }
    cfgRepoIn.addEventListener('input',  () => validateCfgRepo(cfgRepoIn.value, false));
    cfgRepoIn.addEventListener('change', () => validateCfgRepo(cfgRepoIn.value, true));

    globalSec.append(globalHdr, globalBody);
    scroll.appendChild(globalSec);

    // ── Repository Config (collapsible when configured) ───────────────────────
    // remoteCfg is the source of truth when available; fall back to localStorage cache.
    const cfg    = remoteCfg ? { ...DEFAULT_CONFIG, ...remoteCfg } : getConfig(pluginId);
    const isRepoConfigured = !!effectiveRepo(cfg);

    const cfgSec = mk('div', 'border-b border-gray-200 dark:border-gray-700 flex-shrink-0');

    // Clickable header row (always visible)
    const cfgHdrRow = mk('div',
      'gh-repo-hdr flex items-center justify-between px-5 py-3 cursor-pointer select-none transition-colors'
    );
    const cfgArrow    = mk('span', 'text-gray-500 dark:text-gray-400 text-xs mr-2', isRepoConfigured ? '▸' : '▾');
    const cfgTitleGrp = mk('div', 'flex items-center flex-shrink-0');
    cfgTitleGrp.append(cfgArrow, mk('span',
      'text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400', 'Repository'
    ));
    const cfgSummary = mk('span', 'text-xs text-gray-500 dark:text-gray-400 italic truncate ml-2');
    if (isRepoConfigured) cfgSummary.textContent = `${effectiveRepo(cfg)} · ${cfg.branch || 'main'}`;
    cfgHdrRow.append(cfgTitleGrp, cfgSummary);

    // Collapsible body
    const cfgBody = mk('div', 'px-5 pb-5 pt-3');
    cfgBody.style.display = isRepoConfigured ? 'none' : '';

    cfgHdrRow.addEventListener('click', () => {
      const open = cfgBody.style.display !== 'none';
      cfgBody.style.display = open ? 'none' : '';
      cfgArrow.textContent  = open ? '▸' : '▾';
    });

    // Sync status lives at top of body
    const cfgBodyHdr = mk('div', 'flex items-center justify-end mb-3');
    const syncStatus = mk('span', 'text-xs text-gray-500 dark:text-gray-400 italic');
    cfgBodyHdr.appendChild(syncStatus);
    cfgBody.appendChild(cfgBodyHdr);

    // Repo — accepts full GitHub URLs or bare owner/repo
    const repoGroup  = mkFieldGroup('Repository');
    const repoInputRow = mk('div', 'flex gap-1.5');
    const repoIn     = mkInput('https://github.com/owner/repo or owner/repo', cfg.repo);
    repoIn.style.flex = '1';
    const browseBtn  = mk('button',
      'flex-shrink-0 cursor-pointer px-2.5 py-1.5 text-xs font-medium rounded-lg border ' +
      'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 ' +
      'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 ' +
      'transition-colors focus:outline-none', 'Browse ▾'
    );
    browseBtn.type = 'button';
    browseBtn.title = 'Select from your GitHub repositories';
    browseBtn.addEventListener('click', () => {
      if (!getToken()) { alert('Set your GitHub token first.'); return; }
      showRepoPicker(repoInputRow, full_name => {
        repoIn.value = full_name;
        repoIn.dispatchEvent(new Event('input'));
        repoIn.dispatchEvent(new Event('change'));
      });
    });
    repoInputRow.append(repoIn, browseBtn);
    const repoStatus = document.createElement('p');

    const repoLink = document.createElement('a');
    repoLink.target = '_blank';
    repoLink.rel    = 'noopener noreferrer';
    repoLink.style.cssText = 'color:#3b82f6;text-decoration:underline;font-size:0.7rem;margin-left:0.375rem;display:none';
    repoLink.textContent = '↗ Open';

    function validateRepo(raw) {
      const normalized = normalizeRepoInput(raw);
      const parts      = normalized.split('/');
      const valid      = parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
      repoStatus.className   = valid ? 'gh-repo-ok' : (raw.trim() ? 'gh-repo-err' : '');
      repoStatus.textContent = valid
        ? `✓ ${normalized}`
        : (raw.trim() ? 'Paste a GitHub URL or use "owner/repo" format.' : '');
      repoLink.style.display = valid ? '' : 'none';
      if (valid) {
        repoLink.href = `https://github.com/${normalized}`;
        // Use cfg.branch here — branchIn may not be declared yet on initial call.
        // The branchIn change listener keeps cfgSummary in sync after that.
        cfgSummary.textContent = `${normalized} · ${cfg.branch || 'main'}`;
      }
      return valid ? normalized : null;
    }

    // Show validation state for whatever is already saved
    validateRepo(cfg.repo);

    repoIn.addEventListener('input', () => validateRepo(repoIn.value));
    repoIn.addEventListener('change', async () => {
      const normalized = validateRepo(repoIn.value);
      if (normalized) {
        repoIn.value = normalized;
        saveConfig(pluginId, { ...getConfig(pluginId), repo: normalized });
        doRemoteSave();
        if (getToken()) {
          repoStatus.className   = 'text-xs mt-1 text-gray-500 dark:text-gray-400 italic';
          repoStatus.textContent = 'Checking repository…';
          const [o, r] = normalized.split('/');
          const { error } = await ghCheckRepo(o, r);
          repoStatus.className   = error ? 'gh-repo-err' : 'gh-repo-ok';
          repoStatus.textContent = error || `✓ ${normalized}`;
        }
      }
    });

    // "Create repo" button — opens GitHub's new-repo page with the name prefilled
    function slugify(s) {
      return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }
    const createRepoBtn = mk('button',
      'mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full ' +
      'border cursor-pointer transition-colors focus:outline-none ' +
      'border-primary-300 dark:border-primary-700 bg-primary-50 dark:bg-primary-900/30 ' +
      'text-primary-600 dark:text-primary-400 hover:bg-primary-100 dark:hover:bg-primary-900/60'
    );
    createRepoBtn.type = 'button';
    let suggestedName = `trmnl-plugin-${pluginId}`;
    createRepoBtn.textContent = `+ Create "${suggestedName}" on GitHub`;
    // Always start hidden — shown once we have the real name from settings.yml
    createRepoBtn.style.display = 'none';
    const createStatus = mk('p', 'text-xs mt-1 text-gray-500 dark:text-gray-400');

    // Fetch archive to get the plugin name from settings.yml (most reliable source)
    fetchArchive(pluginId).then(files => {
      const nameFromYaml = extractNameFromYaml(files['settings.yml'] || files['settings.yaml'] || '');
      suggestedName = `trmnl-${slugify(nameFromYaml || getPluginName() || `plugin-${pluginId}`)}-plugin`;
      createRepoBtn.textContent = `+ Create "${suggestedName}" on GitHub`;
      if (!effectiveRepo(cfg) && !repoIn.value.trim()) {
        createRepoBtn.style.display = '';
        createStatus.textContent = 'A new tab will open to create the repo. Come back and paste the URL above.';
      }
    }).catch(() => {
      // Fallback: show with DOM-derived name if archive fetch fails
      suggestedName = `trmnl-${slugify(getPluginName() || `plugin-${pluginId}`)}-plugin`;
      createRepoBtn.textContent = `+ Create "${suggestedName}" on GitHub`;
      if (!effectiveRepo(cfg) && !repoIn.value.trim()) {
        createRepoBtn.style.display = '';
        createStatus.textContent = 'A new tab will open to create the repo. Come back and paste the URL above.';
      }
    });

    repoIn.addEventListener('input', () => {
      const empty = !repoIn.value.trim();
      createRepoBtn.style.display = empty ? '' : 'none';
      createStatus.textContent    = empty ? 'A new tab will open to create the repo. Come back and paste the URL above.' : '';
    });

    createRepoBtn.addEventListener('click', () => {
      window.open(
        `https://github.com/new?name=${encodeURIComponent(suggestedName)}&visibility=public`,
        '_blank', 'noopener,noreferrer'
      );
    });

    repoStatus.style.display = 'inline';
    const repoStatusRow = mk('div', 'flex items-center flex-wrap gap-1 mt-1');
    repoStatusRow.append(repoStatus, repoLink);
    repoGroup.append(repoInputRow, createRepoBtn, createStatus, repoStatusRow);
    cfgBody.appendChild(repoGroup);

    // Branch
    const branchGroup = mkFieldGroup('Branch');
    const branchIn    = mkInput('main', cfg.branch);
    branchIn.addEventListener('change', () => {
      saveConfig(pluginId, { ...getConfig(pluginId), branch: branchIn.value.trim() });
      cfgSummary.textContent = `${repoIn.value.trim() || cfg.repo} · ${branchIn.value.trim() || 'main'}`;
      doRemoteSave();
    });
    branchGroup.appendChild(branchIn);
    cfgBody.appendChild(branchGroup);

    // Path — with live resolved preview
    const pathGroup = mkFieldGroup('Path in repo');
    const pathIn    = mkInput('plugin', cfg.path);
    const pathHint  = mk('p', 'text-xs text-gray-500 dark:text-gray-400 mt-1',
      `Resolved: ${resolvePath(cfg.path, pluginId)}`
    );
    pathIn.addEventListener('input', () => {
      pathHint.textContent = `Resolved: ${resolvePath(pathIn.value, pluginId)}`;
    });
    pathIn.addEventListener('change', () => {
      saveConfig(pluginId, { ...getConfig(pluginId), path: pathIn.value.trim() });
      doRemoteSave();
    });
    pathGroup.append(pathIn, pathHint);
    pathGroup.appendChild(mk('p', 'text-xs text-gray-500 dark:text-gray-400',
      '{id} is replaced with the plugin ID.'
    ));
    cfgBody.appendChild(pathGroup);

    // Commit message
    const msgGroup = mkFieldGroup('Commit message');
    const msgIn    = mkInput('TRMNL sync: {name} (plugin {id})', cfg.commitMsg);
    msgIn.addEventListener('change', () => { saveConfig(pluginId, { ...getConfig(pluginId), commitMsg: msgIn.value.trim() }); doRemoteSave(); });
    msgGroup.appendChild(msgIn);
    msgGroup.appendChild(mk('p', 'text-xs text-gray-500 dark:text-gray-400 mt-1',
      '{id} = plugin ID, {name} = plugin name.'
    ));
    cfgBody.appendChild(msgGroup);

    // Auto-push toggle
    const autoWrap  = mk('div', 'flex items-start gap-3 py-1');
    const autoChk   = document.createElement('input');
    autoChk.type    = 'checkbox';
    autoChk.id      = 'gh-autopush-toggle';
    autoChk.checked = !!cfg.autoPush;
    autoChk.className =
      'mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 cursor-pointer flex-shrink-0 ' +
      'text-primary-600 focus:ring-primary-500';
    autoChk.addEventListener('change', () => { saveConfig(pluginId, { ...getConfig(pluginId), autoPush: autoChk.checked }); doRemoteSave(); });

    const autoLbl = mk('label', 'flex flex-col cursor-pointer select-none');
    autoLbl.htmlFor = 'gh-autopush-toggle';
    autoLbl.appendChild(mk('span', 'text-xs font-medium text-gray-700 dark:text-gray-300', 'Auto-push on save'));
    autoLbl.appendChild(mk('span', 'text-xs text-gray-500 dark:text-gray-400',
      'Automatically commit to GitHub whenever you save the plugin.'
    ));
    autoWrap.append(autoChk, autoLbl);
    cfgBody.appendChild(autoWrap);

    // ── Remote config sync ────────────────────────────────────────────────────

    async function doRemoteSave() {
      if (!getToken()) { syncStatus.textContent = 'Set a GitHub token in Global Setup first.'; return; }
      const c = getConfig(pluginId);
      const hasRepo = getConfigRepo() || c.repo;
      if (!hasRepo) { syncStatus.textContent = 'Set a repository first.'; return; }
      try {
        const owner    = c.repo ? parseRepo(c).owner : '';
        const repoName = c.repo ? parseRepo(c).repo  : '';
        syncStatus.textContent = 'Saving…';
        await saveRemoteConfig(owner, repoName, c.branch || 'main', pluginId, c);
        syncStatus.textContent = 'Saved ✓';
        setTimeout(() => { syncStatus.textContent = ''; }, 3000);
      } catch (e) {
        warn('Remote config save failed:', e.message);
        syncStatus.textContent = `Save failed: ${e.message.slice(0, 80)}`;
      }
    }

    // Buttons row: Save config + Reset config
    const cfgBtnRow = mk('div', 'flex items-center gap-3 mt-4 pt-3 border-t border-gray-100 dark:border-gray-700/60');
    const saveCfgBtn = mk('button',
      'cursor-pointer font-medium rounded-lg text-xs px-3 py-1.5 inline-flex items-center ' +
      'transition duration-150 gap-1.5 border-0 ' +
      'text-white bg-primary-500 dark:bg-primary-600 hover:bg-primary-600 dark:hover:bg-primary-500'
    );
    saveCfgBtn.type = 'button';
    saveCfgBtn.textContent = 'Save config';
    saveCfgBtn.addEventListener('click', doRemoteSave);

    const resetCfgBtn = mk('button', 'gh-link-btn', 'Reset config');
    resetCfgBtn.type  = 'button';
    resetCfgBtn.title = 'Clear local config for this plugin';
    resetCfgBtn.style.setProperty('background', 'none', 'important');
    resetCfgBtn.addEventListener('click', () => {
      if (!confirm(
        `Clear GitHub Sync config for plugin ${pluginId}?\n\n` +
        `This removes local settings only — it does not delete the GitHub repository or remote config file.`
      )) return;
      localStorage.removeItem(cfgKey(pluginId));
      localStorage.removeItem(lastPushShasKey(pluginId));
      localStorage.removeItem(lastPushTimeKey(pluginId));
      closePanel();
      setTimeout(openPanel, 350);
    });

    cfgBtnRow.append(saveCfgBtn, resetCfgBtn);
    cfgBody.appendChild(cfgBtnRow);

    cfgSec.append(cfgHdrRow, cfgBody);
    scroll.appendChild(cfgSec);

    // ── Actions ───────────────────────────────────────────────────────────────
    const actionSec = mk('div', 'px-5 py-4');
    actionSec.appendChild(mkSectionHeader(`Actions — Plugin ${pluginId}`));

    // Log area
    const logArea = mk('div',
      'rounded-lg border border-gray-200 dark:border-gray-700 ' +
      'bg-gray-50 dark:bg-gray-800 p-3 mb-4 font-mono text-xs ' +
      'text-gray-600 dark:text-gray-400 overflow-y-auto gh-log'
    );
    const logPlaceholder = mk('span', 'text-gray-500 dark:text-gray-400 italic', 'Ready.');
    logArea.appendChild(logPlaceholder);

    function appendLog(msg, isError = false) {
      if (logArea.querySelector('span.italic')) logArea.querySelector('span.italic').remove();
      const line = document.createElement('div');
      if (isError) line.style.color = '#ef4444';
      line.textContent = msg;
      logArea.appendChild(line);
      logArea.scrollTop = logArea.scrollHeight;
    }

    function clearLog() {
      logArea.replaceChildren();
      logArea.appendChild(mk('span', 'text-gray-500 dark:text-gray-400 italic', 'Ready.'));
    }

    // Push button
    const pushBtn = mk('button',
      'w-full cursor-pointer font-medium rounded-lg text-sm px-4 py-2.5 mb-2.5 ' +
      'inline-flex items-center justify-center gap-2 transition duration-150 border-0 ' +
      'text-white bg-primary-500 dark:bg-primary-600 hover:bg-primary-600 dark:hover:bg-primary-500 ' +
      'disabled:opacity-50 disabled:cursor-not-allowed'
    );
    pushBtn.type = 'button';
    pushBtn.innerHTML =
      `<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">` +
      `<path d="M213.66,154.34a8,8,0,0,1-11.32,11.32L128,91.31,53.66,165.66A8,8,0,0,1,42.34,154.34l80-80a8,8,0,0,1,11.32,0Z"/>` +
      `</svg><span>Push to GitHub</span>`;

    // Pull button
    const pullBtn = mk('button',
      'w-full cursor-pointer font-medium rounded-lg text-sm px-4 py-2.5 ' +
      'inline-flex items-center justify-center gap-2 transition duration-150 ' +
      'border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 ' +
      'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 ' +
      'disabled:opacity-50 disabled:cursor-not-allowed'
    );
    pullBtn.type = 'button';
    pullBtn.innerHTML =
      `<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">` +
      `<path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/>` +
      `</svg><span>Pull from GitHub</span>`;

    function setBusy(busy) {
      pushBtn.disabled = busy;
      pullBtn.disabled = busy;
    }

    pushBtn.addEventListener('click', async () => {
      clearLog();
      setBusy(true);
      const span = pushBtn.querySelector('span');
      span.textContent = 'Pushing…';
      try {
        const commitUrl = await push(pluginId, appendLog);
        if (commitUrl) {
          if (logArea.querySelector('span.italic')) logArea.querySelector('span.italic').remove();
          const linkLine = document.createElement('div');
          const a = document.createElement('a');
          a.href   = commitUrl;
          a.target = '_blank';
          a.rel    = 'noopener noreferrer';
          a.style.color = '#3b82f6';
          a.style.textDecoration = 'underline';
          a.textContent = commitUrl;
          linkLine.appendChild(a);
          logArea.appendChild(linkLine);
          logArea.scrollTop = logArea.scrollHeight;
        }
        // Push succeeded — we are now in sync. Don't re-query GitHub immediately
        // (API caches for minutes after a push). Trust local state instead.
        diffContainer.style.display = 'none';
        compareBtn.querySelector('span').textContent = 'Compare with GitHub';
        // Hide pull button: we just pushed so GitHub matches TRMNL
        document.getElementById(PULL_BTN_ID)?.style.setProperty('display', 'none');
        // Commits will be stale too — just prompt user to refresh manually
        const staleNote = mk('p', 'text-xs text-gray-500 dark:text-gray-400 italic mt-1',
          'Commits may take a moment to reflect the push — click ↺ to refresh.');
        commitsList.appendChild(staleNote);
      } catch (e) {
        warn('Push failed:', e.message);
        appendLog(`✗ ${e.message}`, true);
      } finally {
        span.textContent = 'Push to GitHub';
        setBusy(false);
      }
    });

    pullBtn.addEventListener('click', async () => {
      const cfg2 = getConfig(pluginId);
      const resolved = resolvePath(cfg2.path, pluginId);
      if (!confirm(
        `Pull from GitHub and overwrite plugin ${pluginId}?\n\n` +
        `Source: ${cfg2.repo}/${resolved} (${cfg2.branch || 'main'})\n\n` +
        `This will replace the current plugin content.`
      )) return;

      clearLog();
      setBusy(true);
      const span = pullBtn.querySelector('span');
      span.textContent = 'Pulling…';
      try {
        await pull(pluginId, appendLog);
        // pull() redirects on success; no need to re-enable buttons
      } catch (e) {
        warn('Pull failed:', e.message);
        appendLog(`✗ ${e.message}`, true);
        span.textContent = 'Pull from GitHub';
        setBusy(false);
      }
    });

    // Compare with GitHub button + diff container
    const compareBtn = mk('button',
      'mt-4 w-full cursor-pointer font-medium rounded-lg text-xs px-4 py-2 ' +
      'inline-flex items-center justify-center gap-2 transition duration-150 ' +
      'border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 ' +
      'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 ' +
      'disabled:opacity-50 disabled:cursor-not-allowed'
    );
    compareBtn.type = 'button';
    compareBtn.innerHTML =
      `<svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">` +
      `<path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM40,112H120v32H40Zm0,48H120v32H40Zm176,32H136V112h80Zm0-64H136V64h80ZM40,64H120v32H40Z"/>` +
      `</svg><span>Compare with GitHub</span>`;
    const diffContainer = mk('div', 'mt-3');
    diffContainer.style.display = 'none';

    compareBtn.addEventListener('click', async () => {
      const spanEl = compareBtn.querySelector('span');
      if (diffContainer.style.display !== 'none') {
        diffContainer.style.display = 'none';
        spanEl.textContent = 'Compare with GitHub';
        return;
      }
      compareBtn.disabled = true;
      spanEl.textContent = 'Comparing…';
      diffContainer.style.display = '';
      diffContainer.replaceChildren(mk('p', 'text-xs text-gray-400 italic', 'Loading…'));
      try {
        const c2 = getConfig(pluginId);
        const { owner: o2, repo: r2 } = parseRepo(c2);
        const branch2   = c2.branch.trim() || 'main';
        const basePath2 = resolvePath(c2.path, pluginId);
        const [localFiles, dir] = await Promise.all([
          fetchArchive(pluginId),
          ghFetch(`/repos/${o2}/${r2}/contents/${basePath2}?ref=${encodeURIComponent(branch2)}`),
        ]);
        if (!Array.isArray(dir)) throw new Error(`"${basePath2}" is not a directory.`);
        const ghFiles = {};
        await Promise.all(dir.filter(f => f.type === 'file').map(async f => {
          const d = await ghFetch(`/repos/${o2}/${r2}/contents/${f.path}?ref=${encodeURIComponent(branch2)}`);
          ghFiles[f.name] = b64ToUtf8(d.content);
        }));
        const allNames = [...new Set([...Object.keys(localFiles), ...Object.keys(ghFiles)])].sort();
        if (!allNames.length) throw new Error('No files to compare.');
        diffContainer.replaceChildren();
        for (const name of allNames) {
          diffContainer.appendChild(mk('div', 'text-xs font-semibold text-gray-500 dark:text-gray-400 mt-3 mb-1', name));
          diffContainer.appendChild(ghBuildDiffEl(normalizeLF(ghFiles[name] ?? ''), normalizeLF(localFiles[name] ?? '')));
        }
        spanEl.textContent = 'Hide comparison';
      } catch (e) {
        diffContainer.replaceChildren(mk('p', 'gh-repo-err', `✗ ${e.message}`));
        spanEl.textContent = 'Compare with GitHub';
      } finally {
        compareBtn.disabled = false;
      }
    });

    // ── Recent commits ────────────────────────────────────────────────────────
    const commitsSec  = mk('div', 'px-5 py-4 border-t border-gray-200 dark:border-gray-700');
    const commitsHdr  = mk('div', 'flex items-center justify-between mb-3');
    const commitsTitle = mkSectionHeader('Recent commits');
    commitsTitle.style.marginBottom = '0';
    const refreshCommitsBtn = mk('button', 'gh-commits-refresh', '↺');
    refreshCommitsBtn.type  = 'button';
    refreshCommitsBtn.title = 'Refresh commits';
    commitsHdr.append(commitsTitle, refreshCommitsBtn);

    const commitsList = mk('div', 'space-y-2');
    commitsSec.append(commitsHdr, commitsList);

    async function loadCommits() {
      const c2 = getConfig(pluginId);
      if (!c2.repo || !getToken()) {
        commitsList.replaceChildren(mk('p', 'text-xs text-gray-500 dark:text-gray-400 italic', 'Configure a repository to see commits.'));
        return;
      }
      refreshCommitsBtn.disabled = true;
      refreshCommitsBtn.textContent = '…';
      commitsList.replaceChildren(mk('p', 'text-xs text-gray-500 dark:text-gray-400 italic', 'Loading…'));
      try {
        const { owner: o2, repo: r2 } = parseRepo(c2);
        const branch2   = c2.branch.trim() || 'main';
        const basePath2 = resolvePath(c2.path, pluginId);
        const commits = await ghFetch(
          `/repos/${o2}/${r2}/commits?path=${encodeURIComponent(basePath2)}&sha=${encodeURIComponent(branch2)}&per_page=5`
        );
        commitsList.replaceChildren();
        if (!commits.length) {
          commitsList.appendChild(mk('p', 'text-xs text-gray-500 dark:text-gray-400 italic', 'No commits yet for this path.'));
          return;
        }
        for (const c of commits) {
          const shortSha = c.sha.slice(0, 7);
          const msg      = c.commit.message.split('\n')[0];
          const author   = c.commit.author.name;
          const dateStr  = new Date(c.commit.author.date).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

          const entry   = mk('div', 'border-b border-gray-100 dark:border-gray-800 last:border-0');
          const row     = mk('div', 'flex items-start gap-2 py-1.5');
          const shaLink = mk('a', 'gh-commit-sha flex-shrink-0', shortSha);
          shaLink.href   = c.html_url;
          shaLink.target = '_blank';
          shaLink.rel    = 'noopener noreferrer';

          const info       = mk('div', 'flex-1 min-w-0');
          const msgRow     = mk('div', 'flex items-center gap-1.5');
          const msgSpan    = mk('p', 'text-xs text-gray-700 dark:text-gray-300 truncate flex-1', msg);
          const diffToggle = mk('button', 'gh-commit-diff-toggle flex-shrink-0 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300');
          diffToggle.type  = 'button';
          diffToggle.title = 'Show diff';
          diffToggle.innerHTML = chevronDown;
          msgRow.append(msgSpan, diffToggle);
          info.appendChild(msgRow);
          info.appendChild(mk('p', 'text-xs text-gray-500 dark:text-gray-400 mt-0.5', `${author} · ${dateStr}`));
          row.append(shaLink, info);

          const diffArea = mk('div', '');
          diffArea.style.display = 'none';
          let diffLoaded = false;

          diffToggle.addEventListener('click', async () => {
            const open = diffArea.style.display !== 'none';
            if (open) {
              diffArea.style.display = 'none';
              diffToggle.innerHTML   = chevronDown;
              diffToggle.title       = 'Show diff';
              return;
            }
            diffArea.style.display = '';
            diffToggle.innerHTML   = chevronUp;
            diffToggle.title       = 'Hide diff';
            if (diffLoaded) return;
            diffLoaded = true;
            diffArea.replaceChildren(mk('p', 'text-xs text-gray-400 italic pb-1', 'Loading diff…'));
            try {
              const detail = await ghFetch(`/repos/${o2}/${r2}/commits/${c.sha}`);
              const relevant = (detail.files || []).filter(f =>
                f.filename.startsWith(basePath2 + '/') || f.filename === basePath2
              );
              if (!relevant.length) {
                diffArea.replaceChildren(mk('p', 'text-xs text-gray-400 italic pb-1', 'No changes in this plugin\u2019s path.'));
                return;
              }
              diffArea.replaceChildren();
              for (const f of relevant) {
                const fname = f.filename.replace(basePath2 + '/', '');
                diffArea.appendChild(mk('div', 'text-xs font-semibold text-gray-500 dark:text-gray-400 mt-2 mb-1', fname));
                diffArea.appendChild(renderPatch(f.patch || ''));
              }
            } catch(e) {
              diffArea.replaceChildren(mk('p', 'gh-repo-err text-xs pb-1', `✗ ${e.message.slice(0, 80)}`));
            }
          });

          entry.append(row, diffArea);
          commitsList.appendChild(entry);
        }
      } catch (e) {
        if (e.message.includes('409')) {
          commitsList.replaceChildren(mk('p', 'text-xs text-gray-500 dark:text-gray-400 italic', 'No commits yet — repository is empty.'));
        } else {
          commitsList.replaceChildren(mk('p', 'gh-repo-err text-xs', `Failed to load: ${e.message.slice(0, 80)}`));
        }
      } finally {
        refreshCommitsBtn.disabled    = false;
        refreshCommitsBtn.textContent = '↺';
      }
    }

    refreshCommitsBtn.addEventListener('click', () => loadCommits());

    actionSec.append(logArea, pushBtn, pullBtn, compareBtn, diffContainer);
    scroll.appendChild(actionSec);

    loadCommits();
    scroll.appendChild(commitsSec);

    panel.append(hdr, scroll);
    document.body.append(overlay, panel);
    requestAnimationFrame(() => {
      overlay.classList.add('gh-visible');
      panel.classList.add('gh-visible');
    });
  }

  function closePanel() {
    [PANEL_ID, OVERLAY_ID].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('gh-visible');
      setTimeout(() => el.remove(), 300);
    });
  }

  async function openPanel() {
    if (document.getElementById(PANEL_ID)) { closePanel(); return; }
    const pluginId = getPluginId();
    if (!pluginId) return;

    // GitHub config repo is the source of truth. Fetch it before building the panel
    // so fields always reflect the real stored config, regardless of local cache state.
    let remoteData = null;
    if (getToken() && getConfigRepo()) {
      const btn = document.getElementById(BTN_ID);
      const spinSVG =
        `<svg class="gh-spin" width="12" height="12" viewBox="0 0 256 256" fill="currentColor">` +
        `<path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.69-95.27a8,8,0,0,1,6.62,14.54` +
        `C60.39,61.35,40,93.57,40,128a88,88,0,0,0,176,0c0-34.43-20.39-66.65-51.31-80.73a8,8,0,1,1,6.62-14.54` +
        `C208.19,49.64,232,87,232,128Z"/></svg>`;
      btn?.insertAdjacentHTML('afterbegin', spinSVG);
      try {
        const [o, r] = getConfigRepo().split('/');
        remoteData = await loadAllRemoteConfig(o, r, 'main');
        if (remoteData) cacheConfigData(remoteData); // update local cache
      } catch (e) {
        warn('Config pre-load failed:', e.message);
      } finally {
        btn?.querySelector('.gh-spin')?.remove();
      }
    }

    // Pass the remote config for this plugin directly — buildPanel uses it as
    // the authoritative source rather than reading back from localStorage.
    const remoteCfg = remoteData ? (remoteData[pluginId] || null) : null;
    buildPanel(pluginId, remoteCfg);
  }

  // ---------------------------------------------------------------------------
  // Header buttons (main GitHub panel opener + quick push + pull indicator)
  // ---------------------------------------------------------------------------

  // Fetch both the GitHub directory listing and the TRMNL archive, then update
  // the push/pull header button visibility based on actual content differences.
  async function refreshSyncButtons(pluginId) {
    const cfg = getConfig(pluginId);
    if (!effectiveRepo(cfg) || !getToken()) return;

    const pushBtn = document.getElementById(PUSH_BTN_ID);
    const pullBtn = document.getElementById(PULL_BTN_ID);

    try {
      const { owner, repo } = parseRepo(cfg);
      const branch   = cfg.branch.trim() || 'main';
      const basePath = resolvePath(cfg.path, pluginId);

      const [dir, localFiles] = await Promise.all([
        ghFetch(`/repos/${owner}/${repo}/contents/${basePath}?ref=${encodeURIComponent(branch)}`).catch(e => {
          if (e.message.includes('404') || e.message.includes('409')) return null;
          throw e;
        }),
        fetchArchive(pluginId),
      ]);

      const ghShas = {};
      if (Array.isArray(dir)) {
        for (const f of dir) { if (f.type === 'file') ghShas[f.name] = f.sha; }
      }

      const localNames = Object.keys(localFiles);
      const localShas  = Object.fromEntries(
        await Promise.all(localNames.map(async n => [n, await gitBlobSha(localFiles[n])]))
      );

      // Push button: show only if TRMNL content differs from GitHub
      const hasPushable = !cfg.autoPush && (
        localNames.some(n => localShas[n] !== ghShas[n]) ||
        Object.keys(ghShas).some(n => !localFiles[n])
      );
      if (pushBtn) pushBtn.style.display = hasPushable ? '' : 'none';

      // Pull button: only show if we have a prior push record AND GitHub has drifted from it.
      // Without a stored record we have no baseline — avoid false positives.
      // Also skip during the grace period after a push (GitHub Contents API cache is stale).
      const storedShas    = getLastPushShas(pluginId);
      const hasRecord     = Object.keys(storedShas).length > 0;
      const recentlyPushed = pushAgeMs(pluginId) < PUSH_GRACE_MS;
      const hasPullable   = !recentlyPushed && hasRecord && (
        Object.entries(ghShas).some(([n, sha]) => storedShas[n] !== sha) ||
        Object.keys(storedShas).some(n => !ghShas[n])
      );
      if (pullBtn) {
        pullBtn.style.display = hasPullable ? '' : 'none';
        if (hasPullable) pullBtn.title = 'GitHub has changes — click to open panel';
      }
    } catch { /* silently ignore — buttons stay in their current state */ }
  }

  // Lightweight pull-only check (no archive fetch) — used after push to quickly
  // update the pull indicator without re-fetching the full archive.
  async function checkPullButton(pluginId) {
    const pullBtn = document.getElementById(PULL_BTN_ID);
    if (!pullBtn) return;
    const cfg = getConfig(pluginId);
    if (!effectiveRepo(cfg) || !getToken()) return;
    try {
      const { owner, repo } = parseRepo(cfg);
      const branch   = cfg.branch.trim() || 'main';
      const basePath = resolvePath(cfg.path, pluginId);
      const dir = await ghFetch(
        `/repos/${owner}/${repo}/contents/${basePath}?ref=${encodeURIComponent(branch)}`
      );
      if (!Array.isArray(dir)) return;
      const storedShas    = getLastPushShas(pluginId);
      const hasRecord     = Object.keys(storedShas).length > 0;
      const recentlyPushed = pushAgeMs(pluginId) < PUSH_GRACE_MS;
      const ghShas = {};
      for (const f of dir) { if (f.type === 'file') ghShas[f.name] = f.sha; }
      const hasPullable = !recentlyPushed && hasRecord && (
        Object.entries(ghShas).some(([n, sha]) => storedShas[n] !== sha) ||
        Object.keys(storedShas).some(n => !ghShas[n])
      );
      pullBtn.style.display = hasPullable ? '' : 'none';
      if (hasPullable) pullBtn.title = 'GitHub has changes — click to open panel';
    } catch { /* silently ignore */ }
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return true;
    const pluginId = getPluginId();
    if (!pluginId) return true; // nothing to inject; stop observing

    const h2 = document.querySelector('h2.font-heading');
    if (!h2) return false;

    const baseBtnCls =
      'inline-flex items-center gap-1.5 px-2.5 py-1 flex-shrink-0 ' +
      'text-xs font-medium rounded-full border cursor-pointer transition-colors ' +
      'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 ' +
      'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 ' +
      'focus:outline-none focus:ring-2 focus:ring-primary-500';

    // Main "GitHub" panel button
    const btn = mk('button', baseBtnCls);
    btn.id    = BTN_ID;
    btn.type  = 'button';
    btn.title = 'GitHub Sync';
    btn.innerHTML = ghIcon(14) + `<span>GitHub</span>`;
    btn.addEventListener('click', openPanel);

    // Quick push button — only shown when autoPush is off and a repo is configured
    const cfg = getConfig(pluginId);
    const pushBtn = mk('button', 'gh-hdr-push-btn');
    pushBtn.id   = PUSH_BTN_ID;
    pushBtn.type = 'button';
    pushBtn.title = 'Push to GitHub';
    pushBtn.innerHTML =
      `<svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">` +
      `<path d="M213.66,154.34a8,8,0,0,1-11.32,11.32L128,91.31,53.66,165.66A8,8,0,0,1,42.34,154.34l80-80a8,8,0,0,1,11.32,0Z"/>` +
      `</svg><span>Push</span>`;
    // Always start hidden — refreshSyncButtons will show it if there are actual changes
    pushBtn.style.display = 'none';

    pushBtn.addEventListener('click', async () => {
      if (pushBtn.disabled) return;
      pushBtn.disabled = true;
      const mainBtn = document.getElementById(BTN_ID);
      const spinnerHTML = `<svg class="gh-spin" width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.69-95.27a8,8,0,0,1,6.62,14.54C60.39,61.35,40,93.57,40,128a88,88,0,0,0,176,0c0-34.43-20.39-66.65-51.31-80.73a8,8,0,1,1,6.62-14.54C208.19,49.64,232,87,232,128Z"/></svg>`;
      if (mainBtn) mainBtn.insertAdjacentHTML('afterbegin', spinnerHTML);
      const span = pushBtn.querySelector('span');
      const orig = span.textContent;
      span.textContent = '…';
      try {
        const result = await push(pluginId, () => {});
        span.textContent = result ? '✓' : '—';
        // Hide both buttons immediately — GitHub API caches for minutes after a push,
        // so re-querying would return stale data and falsely show the pull indicator.
        document.getElementById(PULL_BTN_ID)?.style.setProperty('display', 'none');
        if (result) document.getElementById(PUSH_BTN_ID)?.style.setProperty('display', 'none');
      } catch (e) {
        span.textContent = '✗';
        pushBtn.title = e.message;
      } finally {
        pushBtn.disabled = false;
        mainBtn?.querySelector('.gh-spin')?.remove();
        setTimeout(() => { span.textContent = orig; pushBtn.title = 'Push to GitHub'; }, 2500);
      }
    });

    // Pull indicator button — hidden by default, shown when GitHub has newer files
    const pullBtn = mk('button', 'gh-hdr-pull-btn');
    pullBtn.id    = PULL_BTN_ID;
    pullBtn.type  = 'button';
    pullBtn.title = 'GitHub has changes';
    pullBtn.style.display = 'none';
    pullBtn.innerHTML =
      `<svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">` +
      `<path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/>` +
      `</svg><span>Pull</span>`;
    pullBtn.addEventListener('click', openPanel);

    // Insert next to h2.
    // editor-backups always wraps h2 in a new div.flex.items-center.gap-2 via insertBefore,
    // so we must not create our own wrapper (would cause nesting). Instead:
    //   • If a gap-2 wrapper is already present (editor-backups ran first) → append inside it.
    //   • Otherwise append to h2's current parent and watch for editor-backups wrapping h2,
    //     then move the buttons into the new wrapper so they stay adjacent to the title.
    const parent = h2.parentElement;
    if (parent && parent.classList.contains('gap-2')) {
      parent.append(btn, pushBtn, pullBtn);
    } else {
      parent.append(btn, pushBtn, pullBtn);
      // Watch in case editor-backups runs after us and wraps h2
      const wrapObs = new MutationObserver(() => {
        const newParent = h2.parentElement;
        if (newParent !== parent && newParent.classList.contains('gap-2')) {
          newParent.append(btn, pushBtn, pullBtn);
          wrapObs.disconnect();
        }
      });
      wrapObs.observe(parent, { childList: true });
      setTimeout(() => wrapObs.disconnect(), 10_000);
    }

    // Async: check if GitHub has newer files, show spinner on main btn while checking
    const mainSpan = btn.querySelector('span');
    const spinnerHTML = `<svg class="gh-spin" width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.69-95.27a8,8,0,0,1,6.62,14.54C60.39,61.35,40,93.57,40,128a88,88,0,0,0,176,0c0-34.43-20.39-66.65-51.31-80.73a8,8,0,1,1,6.62-14.54C208.19,49.64,232,87,232,128Z"/></svg>`;
    btn.innerHTML = btn.innerHTML.replace('<span>GitHub</span>', `${spinnerHTML}<span>GitHub</span>`);
    refreshSyncButtons(pluginId).finally(() => {
      btn.querySelector('.gh-spin')?.remove();
    });

    log('Buttons injected for plugin', pluginId);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Account page: "Use in GitHub Sync" button next to the API key
  // ---------------------------------------------------------------------------

  function injectAccountButton() {
    if (document.getElementById(ACCT_BTN_ID)) return true;
    const apiInput = document.querySelector('input[id$="-apiKey-copy-btn"]');
    if (!apiInput) return false;
    const apiValue = apiInput.value.trim();
    if (!apiValue) return false;

    const isAlreadySaved = getTrmnlKey() === apiValue;
    const baseCls =
      'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border ' +
      'cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 mt-3 ';
    const clsDefault =
      'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 ' +
      'text-gray-700 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700';
    const clsSaved =
      'text-primary-500 bg-primary-100 dark:bg-primary-900 border-primary-300 dark:border-primary-700';

    const btn = mk('button',
      baseCls + (isAlreadySaved ? clsSaved : clsDefault),
      isAlreadySaved ? '✓ Saved in GitHub Sync' : '↓ Use in GitHub Sync'
    );
    btn.id   = ACCT_BTN_ID;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      saveTrmnlKey(apiValue);
      btn.textContent = '✓ Saved in GitHub Sync';
      btn.className   = baseCls + clsSaved;
    });

    const flexRow   = apiInput.closest('.flex.items-center');
    if (!flexRow) return false;
    const container = flexRow.closest('.p-6') || flexRow.parentElement;
    const docsP     = container.querySelector('a[href*="help.trmnl.com"]')?.closest('p');
    (docsP || container).insertAdjacentElement('afterend', btn);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = mk('style');
    s.id = STYLE_ID;
    s.textContent = `
      #${OVERLAY_ID} {
        position: fixed; inset: 0; background: rgba(0,0,0,.45);
        z-index: 9998; opacity: 0; transition: opacity .25s;
      }
      #${OVERLAY_ID}.gh-visible { opacity: 1; }

      #${PANEL_ID} {
        position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 95vw);
        background: #fff; z-index: 9999;
        box-shadow: -4px 0 40px rgba(0,0,0,.15);
        display: flex; flex-direction: column;
        transform: translateX(100%);
        transition: transform .3s cubic-bezier(.4,0,.2,1);
        font-family: ui-sans-serif, system-ui, sans-serif;
        font-size: 13px; color: #111827;
      }
      #${PANEL_ID}.gh-visible { transform: translateX(0); }
      .dark #${PANEL_ID} { background: #111827; color: #e5e7eb; }

      .gh-log {
        white-space: pre-wrap; word-break: break-all;
        min-height: 5rem; max-height: 10rem;
      }

      /* Global setup header — dark mode hover (Tailwind dark: class doesn't compile here) */
      .dark #${PANEL_ID} .gh-global-hdr:hover { background: rgba(31,41,55,.5); }

      /* Repository section header */
      #${PANEL_ID} .gh-repo-hdr:hover { background: #f9fafb; }
      .dark #${PANEL_ID} .gh-repo-hdr:hover { background: rgba(31,41,55,.5); }

      /* "Change" / link-style button — !important so site button styles can't win */
      #${PANEL_ID} .gh-link-btn {
        background: none !important; border: 0 !important; padding: 0 !important;
        box-shadow: none !important;
        font-size: 0.75rem; line-height: 1rem;
        text-decoration: underline; cursor: pointer;
        color: #9ca3af !important;
      }
      .dark #${PANEL_ID} .gh-link-btn { color: #6b7280 !important; }
      #${PANEL_ID} .gh-link-btn:hover { color: #4b5563 !important; }
      .dark #${PANEL_ID} .gh-link-btn:hover { color: #d1d5db !important; }

      /* Saved / Not-set chips */
      .gh-chip-set {
        display: inline-flex; align-items: center; gap: 0.375rem;
        padding: 0.25rem 0.625rem; border-radius: 9999px;
        font-size: 0.75rem; font-weight: 500;
        background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0;
      }
      .dark .gh-chip-set {
        background: rgba(6,78,59,.25); color: #6ee7b7; border-color: rgba(52,211,153,.3);
      }
      .gh-chip-unset {
        display: inline-flex; align-items: center;
        padding: 0.25rem 0.625rem; border-radius: 9999px;
        font-size: 0.75rem; font-weight: 500;
        background: #f3f4f6; color: #6b7280; border: 1px solid #e5e7eb;
      }
      .dark .gh-chip-unset {
        background: #1f2937; color: #9ca3af; border-color: #374151;
      }

      /* Repo validation hint */
      .gh-repo-ok  { font-size: 0.75rem; color: #16a34a; }
      .dark .gh-repo-ok  { color: #4ade80; }
      .gh-repo-err { font-size: 0.75rem; color: #dc2626; }
      .dark .gh-repo-err { color: #f87171; }

      /* Spinner for async operations on the main header button */
      @keyframes gh-spin { to { transform: rotate(360deg); } }
      .gh-spin { animation: gh-spin 0.8s linear infinite; flex-shrink: 0; }

      /* Header quick-push button */
      .gh-hdr-push-btn {
        display: inline-flex; align-items: center; gap: 0.25rem;
        padding: 0.2rem 0.6rem; border-radius: 9999px;
        font-size: 0.7rem; font-weight: 500; cursor: pointer;
        border: 1px solid #bbf7d0 !important;
        background: #f0fdf4 !important; color: #15803d !important;
        transition: background 0.15s;
      }
      .gh-hdr-push-btn:hover { background: #dcfce7 !important; }
      .gh-hdr-push-btn:disabled { opacity: 0.6; cursor: not-allowed; }
      .dark .gh-hdr-push-btn {
        background: rgba(6,78,59,.25) !important; color: #6ee7b7 !important;
        border-color: rgba(52,211,153,.3) !important;
      }
      .dark .gh-hdr-push-btn:hover { background: rgba(6,78,59,.4) !important; }

      /* Header pull-indicator button */
      .gh-hdr-pull-btn {
        display: inline-flex; align-items: center; gap: 0.25rem;
        padding: 0.2rem 0.6rem; border-radius: 9999px;
        font-size: 0.7rem; font-weight: 500; cursor: pointer;
        border: 1px solid #bfdbfe !important;
        background: #eff6ff !important; color: #2563eb !important;
        transition: background 0.15s;
      }
      .gh-hdr-pull-btn:hover { background: #dbeafe !important; }
      .dark .gh-hdr-pull-btn {
        background: rgba(30,58,138,.25) !important; color: #93c5fd !important;
        border-color: rgba(96,165,250,.3) !important;
      }
      .dark .gh-hdr-pull-btn:hover { background: rgba(30,58,138,.4) !important; }

      /* Diff view */
      .gh-diff {
        font-family: ui-monospace, 'Cascadia Code', monospace;
        font-size: 11px; line-height: 1.6; margin: 0; padding: 0;
        overflow-x: auto; white-space: pre;
        background: #f8fafc;
      }
      .dark .gh-diff { background: #0f172a; }
      .gh-diff-add  { background: #dcfce7; color: #15803d; display: block; }
      .gh-diff-del  { background: #fee2e2; color: #dc2626; display: block; }
      .gh-diff-eq   { color: #9ca3af; display: block; }
      .gh-diff-skip { color: #d1d5db; font-style: italic; display: block; padding-left: 1.5rem; }
      .dark .gh-diff-add  { background: #14532d; color: #86efac; }
      .dark .gh-diff-del  { background: #7f1d1d; color: #fca5a5; }
      .dark .gh-diff-eq   { color: #374151; }
      .dark .gh-diff-skip { color: #4b5563; }
      .gh-hl-del { background: rgba(185,28,28,.25); border-radius: 2px; padding: 0 1px; }
      .gh-hl-add { background: rgba(21,128,61,.25);  border-radius: 2px; padding: 0 1px; }

      /* Commits refresh icon button */
      #${PANEL_ID} .gh-commits-refresh {
        background: none; border: none; padding: 0.2rem 0.4rem;
        font-size: 1rem; line-height: 1; cursor: pointer; border-radius: 4px;
        color: #9ca3af; transition: color 0.15s, background 0.15s;
      }
      #${PANEL_ID} .gh-commits-refresh:hover { color: #4b5563; background: #f3f4f6; }
      .dark #${PANEL_ID} .gh-commits-refresh:hover { color: #d1d5db; background: #374151; }
      #${PANEL_ID} .gh-commits-refresh:disabled { opacity: 0.4; cursor: not-allowed; }

      /* Commit SHA badge */
      .gh-commit-sha {
        font-family: ui-monospace, monospace; font-size: 0.7rem;
        padding: 0.1rem 0.4rem; border-radius: 4px;
        background: #f3f4f6; color: #374151;
        text-decoration: none; border: 1px solid #e5e7eb;
        transition: background 0.15s;
      }
      .gh-commit-sha:hover { background: #e5e7eb; }
      .dark .gh-commit-sha { background: #1f2937; color: #d1d5db; border-color: #374151; }
      .dark .gh-commit-sha:hover { background: #374151; }

      /* Commit diff toggle chevron */
      .gh-commit-diff-toggle {
        background: none; border: none; padding: 0.1rem 0.2rem;
        line-height: 1; cursor: pointer; border-radius: 3px; transition: color 0.15s;
      }

      /* Plugin list page — GitHub managed badge */
      .gh-list-badge {
        display: inline-flex; align-items: center; gap: 0.3rem;
        padding: 0.15rem 0.45rem 0.15rem 0.3rem; border-radius: 5px; cursor: pointer;
        color: #6b7280; text-decoration: none; transition: color 0.15s, background 0.15s;
        flex-shrink: 0; border: 1px solid transparent; margin-left: 0.5rem;
      }
      .gh-list-badge:hover { color: #111827; background: #f3f4f6; border-color: #e5e7eb; }
      .dark .gh-list-badge { color: #9ca3af; }
      .dark .gh-list-badge:hover { color: #e5e7eb; background: #374151; border-color: #4b5563; }
      .gh-list-badge-repo {
        font-size: 0.7rem; font-family: ui-monospace, monospace;
        max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

      /* Repo picker dropdown */
      .gh-repo-picker {
        background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,.12); overflow: hidden;
      }
      .dark .gh-repo-picker { background: #1f2937; border-color: #374151; }
      .gh-repo-picker-search {
        display: block; width: 100%; box-sizing: border-box;
        padding: 0.5rem 0.75rem; font-size: 0.8rem;
        border: none; border-bottom: 1px solid #e5e7eb; outline: none;
        background: #f9fafb; color: #111827;
      }
      .dark .gh-repo-picker-search { background: #111827; color: #f9fafb; border-color: #374151; }
      .gh-repo-picker-list {
        max-height: 220px; overflow-y: auto; padding: 0.25rem;
        font-size: 0.78rem; color: #6b7280;
      }
      .dark .gh-repo-picker-list { color: #9ca3af; }
      .gh-repo-picker-item {
        display: flex; align-items: center; justify-content: space-between;
        width: 100%; box-sizing: border-box; text-align: left;
        padding: 0.35rem 0.6rem; border-radius: 5px; border: none; cursor: pointer;
        background: none; color: #111827; font-size: 0.78rem; gap: 0.5rem;
      }
      .dark .gh-repo-picker-item { color: #f3f4f6; }
      .gh-repo-picker-item:hover { background: #f3f4f6; }
      .dark .gh-repo-picker-item:hover { background: #374151; }
      .gh-repo-picker-private {
        font-size: 0.65rem; padding: 0.1rem 0.35rem; border-radius: 3px;
        background: #fef9c3; color: #854d0e; flex-shrink: 0;
      }
      .dark .gh-repo-picker-private { background: #422006; color: #fbbf24; }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Plugin list page — inject GitHub icon next to managed plugins
  // ---------------------------------------------------------------------------

  const GH_MARK_PATH = `M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956-.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128a10.193 10.193 0 0 1 2.75-.371c.936 0 1.871.123 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915.701.77 1.127 1.747 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.922-11-11-11Z`;
  function ghIcon(size = 14) {
    return `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" style="vertical-align:text-bottom;overflow:visible"><path d="${GH_MARK_PATH}"/></svg>`;
  }
  const GH_OCTICON = ghIcon(14);

  function isListPage() {
    return location.pathname === '/plugin_settings' && location.search.includes('keyname=private_plugin');
  }

  function tryInjectListBadges() {
    const rows = document.querySelectorAll('[data-action*="plugin-settings#editSetting"]');
    rows.forEach(row => {
      if (row.getAttribute(LIST_BADGE_ATTR)) return; // already processed
      const id = row.getAttribute('data-plugin-settings-id');
      if (!id) { row.setAttribute(LIST_BADGE_ATTR, 'skip'); return; }
      const rowCfg = getConfig(id);
      if (!effectiveRepo(rowCfg)) return; // no config yet — observer will retry once config loads
      const actionsDiv = row.closest('.flex.items-center.text-sm.cursor-pointer')
        ?.querySelector('.flex.items-center.flex-shrink-0');
      if (!actionsDiv) return; // not in DOM yet — observer will retry
      const badge = document.createElement('a');
      badge.className = 'gh-list-badge';
      badge.href      = `https://github.com/${effectiveRepo(rowCfg)}`;
      badge.target    = '_blank';
      badge.rel       = 'noopener noreferrer';
      badge.title     = `Open on GitHub: ${effectiveRepo(rowCfg)}`;
      const repoLabel = document.createElement('span');
      repoLabel.className   = 'gh-list-badge-repo';
      repoLabel.textContent = effectiveRepo(rowCfg).split('/')[1] || effectiveRepo(rowCfg);
      badge.innerHTML = GH_OCTICON;
      badge.appendChild(repoLabel);
      actionsDiv.prepend(badge);
      row.setAttribute(LIST_BADGE_ATTR, 'done');
    });
  }

  async function setupListPage() {
    injectStyle();
    tryInjectListBadges();

    const target = document.querySelector('[data-controller="plugin-settings"]') || document.documentElement;
    const obs = new MutationObserver(() => tryInjectListBadges());
    obs.observe(target, { childList: true, subtree: true });
    // No hard disconnect — turbo navigation replaces the document, cleaning up automatically

    // Proactively load remote config so badges appear even before the panel is opened
    const cr = getConfigRepo();
    if (cr && cr.includes('/') && getToken()) {
      const [o, r] = cr.split('/');
      try {
        const data = await loadAllRemoteConfig(o, r, 'main');
        if (data) { cacheConfigData(data); tryInjectListBadges(); }
      } catch (e) {
        warn('List page: Config preload failed:', e.message);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function setup() {
    if (isListPage()) { setupListPage(); return; }

    injectStyle();

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

    checkAutoPush();

    function tryAttach() {
      attachAutoSave(pluginId);
      return !!document.querySelector('form[data-gh-sync-attached="true"]');
    }
    if (!tryAttach()) {
      const obs = new MutationObserver(() => { if (tryAttach()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 60_000);
    }

    if (!injectButton()) {
      const obs = new MutationObserver(() => { if (injectButton()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  function onNavigate() {
    if (isListPage()) { setupListPage(); return; }
    closePanel();
    if (isAccountPage()) { injectAccountButton(); return; }
    const pluginId = getPluginId();
    if (pluginId) {
      checkAutoPush();
      attachAutoSave(pluginId);
    }
    if (!injectButton()) {
      const obs = new MutationObserver(() => { if (injectButton()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 15_000);
    }
  }

  document.addEventListener('turbo:load', () => onNavigate());

  window.navigation?.addEventListener('navigate', () => setTimeout(onNavigate, 0));

  log('Script loaded.');
  setup();

})();
