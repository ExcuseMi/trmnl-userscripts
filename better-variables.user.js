// ==UserScript==
// @name         TRMNL Export Variables
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.0.0
// @description  Replaces the variables accordion with an interactive JSON tree viewer + YAML export.
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings/*/markup/edit*
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/better-variables.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/better-variables.user.js
// @grant        none
// @run-at       document-body
// ==/UserScript==

(function () {
  'use strict';

  const WIDGET_ID = 'trmnl-export-vars-widget';
  const STYLE_ID  = 'trmnl-export-vars-style';

  let cachedData = null;
  let format     = 'json'; // 'json' | 'yaml'

  // ---------------------------------------------------------------------------
  // Data extraction
  // ---------------------------------------------------------------------------

  function extractVariables() {
    const result = {};
    document.querySelectorAll('[data-variable-fold-target="toggleButton"]').forEach(btn => {
      const code = btn.querySelector('code');
      if (!code) return;

      const contentId = btn.getAttribute('aria-controls');
      let pre = contentId ? document.getElementById(contentId)?.querySelector('pre') : null;

      if (!pre) {
        let sib = btn.nextElementSibling;
        while (sib && !pre) {
          pre = sib.tagName === 'PRE' ? sib : sib.querySelector('pre');
          sib = sib.nextElementSibling;
        }
      }

      if (!pre) return;

      const name = code.textContent.replace(/\{\{\s*|\s*\}\}/g, '').trim();
      const raw  = pre.textContent.trim();
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; }
      result[name] = value;
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Serializers
  // ---------------------------------------------------------------------------

  function toJson(data) {
    return JSON.stringify(data, null, 2);
  }

  function toYaml(data) {
    function yamlStr(s) {
      if (s === '' || /[:#\[\]{},&*?|<>=!%@`\n\r]/.test(s) ||
          /^(true|false|null|yes|no|on|off)$/i.test(s) ||
          /^\s|\s$/.test(s) || /^\d/.test(s)) {
        return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
      }
      return s;
    }
    function serialize(val, depth) {
      const pad = '  '.repeat(depth);
      if (val === null)             return 'null';
      if (typeof val === 'boolean') return String(val);
      if (typeof val === 'number')  return String(val);
      if (typeof val === 'string')  return yamlStr(val);
      if (Array.isArray(val)) {
        if (!val.length) return '[]';
        return val.map(v => {
          // Object in array: put first key on the dash line
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            const ents = Object.entries(v);
            if (!ents.length) return `\n${pad}- {}`;
            return ents.map(([k2, v2], i2) => {
              const sv2  = serialize(v2, depth + 1);
              const blk2 = typeof v2 === 'object' && v2 !== null &&
                           (Array.isArray(v2) ? v2.length > 0 : Object.keys(v2).length > 0);
              const line = `${k2}:${blk2 ? sv2 : ' ' + sv2}`;
              return i2 === 0 ? `\n${pad}- ${line}` : `\n${pad}  ${line}`;
            }).join('');
          }
          return `\n${pad}- ${serialize(v, depth + 1)}`;
        }).join('');
      }
      const entries = Object.entries(val);
      if (!entries.length) return '{}';
      return entries.map(([k, v]) => {
        const sv    = serialize(v, depth + 1);
        const block = typeof v === 'object' && v !== null &&
                      (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
        return `\n${pad}${k}:${block ? sv : ' ' + sv}`;
      }).join('');
    }
    const lines = [];
    for (const [k, v] of Object.entries(data)) {
      const sv    = serialize(v, 1);
      const block = typeof v === 'object' && v !== null &&
                    (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
      lines.push(`${k}:${block ? sv : ' ' + sv}`);
    }
    return lines.join('\n') + '\n';
  }

  function currentText() {
    return format === 'yaml' ? toYaml(cachedData) : toJson(cachedData);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls)                el.className   = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  async function copyText(text, el, flash) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = Object.assign(mk('textarea'), { value: text });
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    if (!el || !flash) return;
    const prev = el.textContent;
    el.textContent = flash;
    setTimeout(() => { el.textContent = prev; }, 900);
  }

  function svgBtn(label, pathD) {
    const btn = mk('button', 'ev-btn');
    btn.type = 'button';
    btn.innerHTML = `<svg width="13" height="13" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="${pathD}"/></svg>`;
    btn.appendChild(mk('span', null, label));
    return btn;
  }

  // ---------------------------------------------------------------------------
  // JSON tree builder
  // ---------------------------------------------------------------------------

  function childPath(parentPath, key, isArr) {
    if (!parentPath) return String(key);
    return isArr ? `${parentPath}[${key}]` : `${parentPath}.${key}`;
  }

  function scalarNode(val, path) {
    const span = mk('span');
    if (val === null)                  { span.className = 'jv-null'; span.textContent = 'null'; }
    else if (typeof val === 'boolean') { span.className = 'jv-bool'; span.textContent = String(val); }
    else if (typeof val === 'number')  { span.className = 'jv-num';  span.textContent = String(val); }
    else                               { span.className = 'jv-str';  span.textContent = `"${val}"`; }
    if (path) {
      span.classList.add('jv-copy');
      span.title = 'Click to copy value';
      span.addEventListener('click', e => {
        e.stopPropagation();
        copyText(val === null ? 'null' : String(val), span, '✓');
      });
    }
    return span;
  }

  function keyNode(key, path) {
    // Numbers are array indices → display as [n], strings as "key"
    const isIdx = typeof key === 'number';
    const span  = mk('span', 'jv-key', isIdx ? `[${key}]` : `"${key}"`);
    if (path) {
      span.classList.add('jv-copy');
      span.title = `Click to copy {{ ${path} }}`;
      span.addEventListener('click', e => {
        e.stopPropagation();
        copyText(`{{ ${path} }}`, span, '✓');
      });
    }
    return span;
  }

  function buildNode(val, key, isLast, path) {
    const isArr  = Array.isArray(val);
    const isObj  = val !== null && typeof val === 'object';
    const comma  = isLast ? '' : ',';

    if (!isObj) {
      const row = mk('div', 'jv-row');
      if (key !== null) { row.appendChild(keyNode(key, path)); row.appendChild(mk('span', 'jv-p', ': ')); }
      row.appendChild(scalarNode(val, path));
      if (comma) row.appendChild(mk('span', 'jv-p', comma));
      return row;
    }

    const entries = isArr ? val.map((v, i) => [i, v]) : Object.entries(val);
    const open    = isArr ? '[' : '{';
    const close   = isArr ? ']' : '}';

    if (!entries.length) {
      const row = mk('div', 'jv-row');
      if (key !== null) { row.appendChild(keyNode(key, path)); row.appendChild(mk('span', 'jv-p', ': ')); }
      row.appendChild(mk('span', 'jv-p', open + close + comma));
      return row;
    }

    const wrap   = mk('div', 'jv-node');
    const header = mk('div', 'jv-header');
    const arrow  = mk('span', 'jv-arrow', '▾');
    header.appendChild(arrow);
    if (key !== null) { header.appendChild(keyNode(key, path)); header.appendChild(mk('span', 'jv-p', ': ')); }
    header.appendChild(mk('span', 'jv-p', open));

    const preview = mk('span', 'jv-preview',
      isArr ? `… ${val.length} items${close}${comma}` : `… ${entries.length} keys${close}${comma}`);
    preview.style.display = 'none';
    header.appendChild(preview);

    // Copy subtree button (visible on hover)
    const copyObjBtn = mk('span', 'jv-obj-copy', '⧉');
    copyObjBtn.title = 'Copy as JSON';
    copyObjBtn.addEventListener('click', e => {
      e.stopPropagation();
      copyText(JSON.stringify(val, null, 2), copyObjBtn, '✓');
    });
    header.appendChild(copyObjBtn);

    wrap.appendChild(header);

    const body = mk('div', 'jv-body');
    entries.forEach(([k, v], i) =>
      body.appendChild(buildNode(v, isArr ? i : k, i === entries.length - 1, childPath(path, k, isArr)))
    );
    wrap.appendChild(body);

    const closeRow = mk('div', 'jv-row');
    closeRow.appendChild(mk('span', 'jv-p', close + comma));
    wrap.appendChild(closeRow);

    let collapsed = false;
    header.addEventListener('click', () => {
      collapsed = !collapsed;
      arrow.textContent      = collapsed ? '▸' : '▾';
      body.style.display     = collapsed ? 'none' : '';
      closeRow.style.display = collapsed ? 'none' : '';
      preview.style.display  = collapsed ? '' : 'none';
    });
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // YAML syntax-highlighted viewer
  // ---------------------------------------------------------------------------

  function yamlVal(s) {
    if (!s) return mk('span');
    if (s === 'null' || s === '~')       return mk('span', 'jv-null', s);
    if (s === 'true' || s === 'false')   return mk('span', 'jv-bool', s);
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return mk('span', 'jv-num', s);
    return mk('span', 'jv-str', s);
  }

  function buildYamlView(text) {
    const container = mk('div', 'ev-yaml-view');
    const lines = text.split('\n');
    // Drop trailing empty line from toYaml's trailing \n
    if (lines[lines.length - 1] === '') lines.pop();
    lines.forEach(line => {
      const row = mk('div', 'yv-row');
      // "  - key: value" or "- key: value"
      const mDashKey = line.match(/^(\s*)-\s+([\w-]+):\s*(.*)$/);
      if (mDashKey) {
        const [, indent, key, val] = mDashKey;
        row.appendChild(document.createTextNode(indent));
        row.appendChild(mk('span', 'yv-dash', '- '));
        row.appendChild(mk('span', 'jv-key', key));
        row.appendChild(mk('span', 'jv-p', ':'));
        if (val) { row.appendChild(document.createTextNode(' ')); row.appendChild(yamlVal(val)); }
        container.appendChild(row);
        return;
      }
      // "  - scalar" or bare "- "
      const mDash = line.match(/^(\s*)-\s*(.*)$/);
      if (mDash) {
        const [, indent, rest] = mDash;
        row.appendChild(document.createTextNode(indent));
        row.appendChild(mk('span', 'yv-dash', '- '));
        if (rest) row.appendChild(yamlVal(rest));
        container.appendChild(row);
        return;
      }
      // "  key: value" or "key:"
      const mKey = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
      if (mKey) {
        const [, indent, key, val] = mKey;
        row.appendChild(document.createTextNode(indent));
        row.appendChild(mk('span', 'jv-key', key));
        row.appendChild(mk('span', 'jv-p', ':'));
        if (val) { row.appendChild(document.createTextNode(' ')); row.appendChild(yamlVal(val)); }
        container.appendChild(row);
        return;
      }
      row.appendChild(document.createTextNode(line));
      container.appendChild(row);
    });
    return container;
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const W = `#${WIDGET_ID}`;
    const s = mk('style');
    s.id = STYLE_ID;
    s.textContent = `
      ${W} { font-family: ui-monospace,'Cascadia Code','Fira Code',monospace; font-size:12px; line-height:1.7; overflow-x:auto; max-width:100%; }
      ${W} .ev-toolbar { display:flex; align-items:center; gap:0.4rem; margin-bottom:0.6rem; flex-wrap:wrap; }
      ${W} .ev-size    { margin-left:auto; color:#9ca3af; font-size:11px; }
      ${W} .ev-fmt-group { display:inline-flex; border-radius:6px; overflow:hidden; border:1px solid #d1d5db; }
      .dark ${W} .ev-fmt-group { border-color:#4b5563; }
      ${W} .ev-btn {
        display:inline-flex; align-items:center; gap:4px; padding:3px 8px;
        font-size:11px; font-weight:500; font-family:inherit;
        cursor:pointer; border:0; border-radius:6px; transition:background 150ms;
        color:#374151; background:#e5e7eb;
      }
      ${W} .ev-btn:hover { background:#d1d5db; }
      .dark ${W} .ev-btn { color:#d1d5db; background:#374151; }
      .dark ${W} .ev-btn:hover { background:#4b5563; }
      ${W} .ev-fmt-group .ev-btn { border-radius:0; }
      ${W} .ev-fmt-group .ev-btn:first-child { border-radius:5px 0 0 5px; }
      ${W} .ev-fmt-group .ev-btn:last-child  { border-radius:0 5px 5px 0; }
      ${W} .ev-fmt-group .ev-btn.ev-active { background:#374151; color:#f9fafb; }
      ${W} .ev-fmt-group .ev-btn.ev-active:hover { background:#4b5563; }
      .dark ${W} .ev-fmt-group .ev-btn.ev-active { background:#e5e7eb; color:#111827; }
      .dark ${W} .ev-fmt-group .ev-btn.ev-active:hover { background:#d1d5db; }

      /* JSON tree */
      ${W} .jv-body    { padding-left:1.25rem; }
      ${W} .jv-row     { display:flex; flex-wrap:wrap; align-items:baseline; gap:0.15rem; }
      ${W} .jv-header  { display:flex; align-items:baseline; gap:0.15rem; cursor:pointer; border-radius:3px; padding:0 2px; position:relative; }
      ${W} .jv-header:hover { background:rgba(0,0,0,.04); }
      .dark ${W} .jv-header:hover { background:rgba(255,255,255,.05); }
      ${W} .jv-arrow   { font-size:9px; color:#9ca3af; user-select:none; width:.85rem; flex-shrink:0; }
      ${W} .jv-key     { color:#2563eb; }
      ${W} .jv-str     { color:#16a34a; word-break:break-all; }
      ${W} .jv-num     { color:#dc2626; }
      ${W} .jv-bool    { color:#9333ea; }
      ${W} .jv-null    { color:#9ca3af; }
      ${W} .jv-p       { color:#6b7280; }
      ${W} .jv-preview { color:#9ca3af; font-style:italic; }
      ${W} .jv-copy    { cursor:copy; border-radius:2px; }
      ${W} .jv-copy:hover { background:rgba(0,0,0,.06); outline:1px dashed #9ca3af; }
      ${W} .jv-obj-copy {
        display:none; margin-left:auto; padding:0 3px; font-size:10px;
        cursor:copy; color:#9ca3af; user-select:none; border-radius:2px;
      }
      ${W} .jv-header:hover .jv-obj-copy { display:inline; }
      ${W} .jv-obj-copy:hover { background:rgba(0,0,0,.08); color:#374151; }
      .dark ${W} .jv-arrow   { color:#64748b; }
      .dark ${W} .jv-key     { color:#7dd3fc; }
      .dark ${W} .jv-str     { color:#86efac; }
      .dark ${W} .jv-num     { color:#fca5a5; }
      .dark ${W} .jv-bool    { color:#c4b5fd; }
      .dark ${W} .jv-null    { color:#64748b; }
      .dark ${W} .jv-p       { color:#94a3b8; }
      .dark ${W} .jv-preview { color:#64748b; }
      .dark ${W} .jv-copy:hover { background:rgba(255,255,255,.07); }
      .dark ${W} .jv-obj-copy:hover { background:rgba(255,255,255,.09); color:#e5e7eb; }

      /* YAML viewer */
      ${W} .ev-yaml-view { }
      ${W} .yv-row { white-space:pre-wrap; word-break:break-all; overflow-wrap:anywhere; }
      ${W} .yv-dash { color:#9ca3af; }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // Injection
  // ---------------------------------------------------------------------------

  function injectUI() {
    if (document.getElementById(WIDGET_ID)) return false;

    const body = document.getElementById('accordion-open-body-1');
    if (!body) return false;
    const container = body.querySelector('[data-controller="variable-fold"]');
    if (!container) return false;

    const data = extractVariables();
    if (!Object.keys(data).length) return false;
    cachedData = data;

    const widget = mk('div');
    widget.id = WIDGET_ID;
    widget.className = 'p-4';

    // Format toggle (segmented control)
    const fmtGroup  = mk('div', 'ev-fmt-group');
    const jsonBtn   = mk('button', 'ev-btn', 'JSON');
    const yamlBtn   = mk('button', 'ev-btn', 'YAML');
    jsonBtn.type    = 'button';
    yamlBtn.type    = 'button';
    fmtGroup.appendChild(jsonBtn);
    fmtGroup.appendChild(yamlBtn);

    // Copy / Download
    const copyBtn     = svgBtn('Copy',     'M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z');
    const downloadBtn = svgBtn('Download', 'M224,152v56a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V152a8,8,0,0,1,16,0v56H208V152a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,132.69V40a8,8,0,0,0-16,0v92.69L93.66,106.34a8,8,0,0,0-11.32,11.32Z');
    const sizeEl = mk('span', 'ev-size');

    // Content areas
    const treeEl = mk('div');           // JSON interactive tree
    const yamlEl = mk('div');           // YAML viewer (rebuilt on switch)
    yamlEl.style.display = 'none';

    const toolbar = mk('div', 'ev-toolbar');

    function refresh() {
      const ext = format === 'yaml' ? 'yml' : 'json';
      copyBtn.querySelector('span').textContent     = `Copy ${format.toUpperCase()}`;
      downloadBtn.querySelector('span').textContent = `Download .${ext}`;
      jsonBtn.classList.toggle('ev-active', format === 'json');
      yamlBtn.classList.toggle('ev-active', format === 'yaml');

      if (format === 'json') {
        treeEl.replaceChildren(buildNode(cachedData, null, true, ''));
        treeEl.style.display = '';
        yamlEl.style.display = 'none';
        sizeEl.textContent   = `${(toJson(cachedData).length / 1024).toFixed(1)} KB`;
      } else {
        const yaml = toYaml(cachedData);
        yamlEl.replaceChildren(buildYamlView(yaml));
        yamlEl.style.display = '';
        treeEl.style.display = 'none';
        sizeEl.textContent   = `${(yaml.length / 1024).toFixed(1)} KB`;
      }
    }

    jsonBtn.addEventListener('click', () => { format = 'json'; refresh(); });
    yamlBtn.addEventListener('click', () => { format = 'yaml'; refresh(); });

    copyBtn.addEventListener('click', async () => {
      const span = copyBtn.querySelector('span');
      await copyText(currentText(), span, 'Copied!');
    });

    downloadBtn.addEventListener('click', () => {
      const pluginId = window.location.pathname.match(/\/plugin_settings\/(\d+)\//)?.[1] ?? 'plugin';
      const isYaml   = format === 'yaml';
      const a = Object.assign(mk('a'), {
        href:     URL.createObjectURL(new Blob([currentText()], { type: isYaml ? 'text/yaml' : 'application/json' })),
        download: `trmnl-${pluginId}-variables.${isYaml ? 'yml' : 'json'}`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });

    toolbar.appendChild(fmtGroup);
    toolbar.appendChild(copyBtn);
    toolbar.appendChild(downloadBtn);
    toolbar.appendChild(sizeEl);
    widget.appendChild(toolbar);
    widget.appendChild(treeEl);
    widget.appendChild(yamlEl);

    refresh();

    container.style.display = 'none';
    container.insertAdjacentElement('afterend', widget);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  injectStyle();
  injectUI();

  const observer = new MutationObserver(() => {
    if (!document.getElementById(WIDGET_ID)) injectUI();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('turbo:load', () => {
    document.getElementById(WIDGET_ID)?.remove();
    document.querySelectorAll('[data-controller="variable-fold"]')
      .forEach(c => { c.style.display = ''; });
    cachedData = null;
    format     = 'json';
    injectUI();
  });

})();
