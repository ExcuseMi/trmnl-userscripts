// ==UserScript==
// @name         TRMNL Better Variables
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.1.2
// @description  Adds an interactive JSON tree viewer + YAML export with copy features inside the existing variables accordion.
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

  const WIDGET_ID = 'trmnl-better-vars-widget';
  const STYLE_ID  = 'trmnl-better-vars-style';

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
        return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
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
      header.classList.toggle('jv-collapsed', collapsed);
      body.style.display     = collapsed ? 'none' : '';
      closeRow.style.display = collapsed ? 'none' : '';
      preview.style.display  = collapsed ? '' : 'none';
    });
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // YAML syntax-highlighted viewer with interactive features
  // ---------------------------------------------------------------------------

  function yamlValWithCopy(val, path) {
    const span = mk('span');

    // Handle different value types
    if (val === 'null' || val === '~') {
      span.className = 'jv-null jv-copy';
      span.textContent = val;
    } else if (val === 'true' || val === 'false') {
      span.className = 'jv-bool jv-copy';
      span.textContent = val;
    } else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(val)) {
      span.className = 'jv-num jv-copy';
      span.textContent = val;
    } else {
      span.className = 'jv-str jv-copy';
      span.textContent = val;
    }

    if (path) {
      span.title = 'Click to copy value';
      span.addEventListener('click', e => {
        e.stopPropagation();
        // Remove quotes if present
        const value = val.startsWith('"') && val.endsWith('"')
          ? val.slice(1, -1)
          : val;
        copyText(value, span, '✓');
      });
    }

    return span;
  }

  function buildYamlView(text, data) {
    const container = mk('div', 'ev-yaml-view');
    const lines = text.split('\n');
    // Drop trailing empty line from toYaml's trailing \n
    if (lines[lines.length - 1] === '') lines.pop();

    // Build a map of paths to values for the YAML structure
    function buildPathMap(obj, basePath = '') {
      let map = new Map();
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = basePath ? `${basePath}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          // Nested object
          map.set(currentPath, { type: 'object', value });
          const nestedMap = buildPathMap(value, currentPath);
          nestedMap.forEach((v, k) => map.set(k, v));
        } else if (Array.isArray(value)) {
          // Array
          map.set(currentPath, { type: 'array', value });
          value.forEach((item, index) => {
            const arrayPath = `${currentPath}[${index}]`;
            if (item && typeof item === 'object') {
              map.set(arrayPath, { type: 'object', value: item });
              const nestedMap = buildPathMap(item, arrayPath);
              nestedMap.forEach((v, k) => map.set(k, v));
            } else {
              map.set(arrayPath, { type: typeof item, value: item });
            }
          });
        } else {
          // Scalar
          map.set(currentPath, { type: typeof value, value });
        }
      }
      return map;
    }

    const pathMap = buildPathMap(data);

    lines.forEach(line => {
      const row = mk('div', 'yv-row');

      // Handle array items with key-value pairs: "  - key: value"
      const mDashKey = line.match(/^(\s*)-\s+([\w-]+):\s*(.*)$/);
      if (mDashKey) {
        const [, indent, key, val] = mDashKey;
        row.appendChild(document.createTextNode(indent));

        // Dash
        const dash = mk('span', 'yv-dash', '- ');
        row.appendChild(dash);

        // Key with copy functionality
        const keySpan = mk('span', 'jv-key jv-copy', key);
        keySpan.title = `Click to copy {{ ${key} }}`;
        keySpan.addEventListener('click', e => {
          e.stopPropagation();
          copyText(`{{ ${key} }}`, keySpan, '✓');
        });
        row.appendChild(keySpan);

        row.appendChild(mk('span', 'jv-p', ':'));

        if (val) {
          row.appendChild(document.createTextNode(' '));
          // Try to find the actual value in our path map
          const value = val.startsWith('"') && val.endsWith('"')
            ? val.slice(1, -1)
            : val;
          row.appendChild(yamlValWithCopy(value, key));
        }
        container.appendChild(row);
        return;
      }

      // Handle bare array items: "  - value"
      const mDash = line.match(/^(\s*)-\s*(.*)$/);
      if (mDash) {
        const [, indent, rest] = mDash;
        row.appendChild(document.createTextNode(indent));
        row.appendChild(mk('span', 'yv-dash', '- '));
        if (rest) {
          // For array items, we need to determine if it's a scalar or object start
          if (rest.startsWith('{') || rest.startsWith('}') || rest.startsWith('[') || rest.startsWith(']')) {
            row.appendChild(mk('span', 'jv-p', rest));
          } else {
            row.appendChild(yamlValWithCopy(rest));
          }
        }
        container.appendChild(row);
        return;
      }

      // Handle key-value pairs: "  key: value"
      const mKey = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
      if (mKey) {
        const [, indent, key, val] = mKey;
        row.appendChild(document.createTextNode(indent));

        // Key with copy functionality
        const keySpan = mk('span', 'jv-key jv-copy', key);
        keySpan.title = `Click to copy {{ ${key} }}`;
        keySpan.addEventListener('click', e => {
          e.stopPropagation();
          copyText(`{{ ${key} }}`, keySpan, '✓');
        });
        row.appendChild(keySpan);

        row.appendChild(mk('span', 'jv-p', ':'));

        if (val) {
          row.appendChild(document.createTextNode(' '));
          // Check if it's a complex structure start
          if (val.startsWith('{') || val.startsWith('}') || val.startsWith('[') || val.startsWith(']')) {
            row.appendChild(mk('span', 'jv-p', val));
          } else {
            row.appendChild(yamlValWithCopy(val, key));
          }
        }
        container.appendChild(row);
        return;
      }

      // Handle brackets and other structural elements
      if (line.includes('{') || line.includes('}') || line.includes('[') || line.includes(']')) {
        const parts = line.split(/([{}[\]])/g);
        parts.forEach(part => {
          if (part === '{' || part === '}' || part === '[' || part === ']') {
            row.appendChild(mk('span', 'jv-p', part));
          } else if (part) {
            row.appendChild(document.createTextNode(part));
          }
        });
      } else {
        row.appendChild(document.createTextNode(line));
      }

      container.appendChild(row);
    });

    // Post-process: tag each row with its depth and wire up collapse
    const allRows = Array.from(container.children);
    allRows.forEach((row, i) => {
      row.dataset.yvDepth = lines[i].match(/^(\s*)/)[1].length;
    });
    allRows.forEach((row, i) => {
      const depth = +row.dataset.yvDepth;
      const nextDepth = +(allRows[i + 1]?.dataset.yvDepth ?? -1);
      if (nextDepth > depth) {
        const children = [];
        for (let j = i + 1; j < allRows.length; j++) {
          if (+allRows[j].dataset.yvDepth <= depth) break;
          children.push(allRows[j]);
        }
        row.classList.add('yv-parent');
        row.addEventListener('click', e => {
          if (e.target.classList.contains('jv-copy')) return;
          const col = row.classList.toggle('yv-collapsed');
          children.forEach(c => { c.style.display = col ? 'none' : ''; });
        });
      }
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
      /* Widget root — hard cap matching TRMNL's own max-w-[80vw] on the variable list */
      ${W} { overflow:hidden; word-break:break-all; overflow-wrap:anywhere; }

      /* JSON tree */
      ${W} .jv-body    { padding-left:1.25rem; }
      ${W} .jv-row     { display:block; word-break:break-all; overflow-wrap:anywhere; line-height:1.6; padding-left:0.9rem; }
      ${W} .jv-header  { display:flex; align-items:baseline; gap:0.15rem; cursor:pointer; border-radius:3px; padding:1px 2px 1px 0.9rem; position:relative; }
      ${W} .jv-header:hover { background:rgba(0,0,0,.04); }
      .dark ${W} .jv-header:hover { background:rgba(255,255,255,.05); }
      ${W} .jv-header::before { content:'▾'; position:absolute; left:2px; font-size:9px; color:#9ca3af; user-select:none; line-height:1.6; }
      ${W} .jv-header.jv-collapsed::before { content:'▸'; }
      ${W} .jv-key     { color:#2563eb; }
      ${W} .jv-str     { color:#16a34a; }
      ${W} .jv-num     { color:#dc2626; }
      ${W} .jv-bool    { color:#9333ea; }
      ${W} .jv-null    { color:#9ca3af; }
      ${W} .jv-p       { color:#6b7280; }
      ${W} .jv-preview { color:#9ca3af; font-style:italic; }
      ${W} .jv-copy    { cursor:copy; border-radius:2px; padding:0 2px; }
      ${W} .jv-copy:hover { background:rgba(0,0,0,.06); outline:1px dashed #9ca3af; }
      ${W} .jv-obj-copy {
        display:none; margin-left:auto; padding:0 3px; font-size:10px;
        cursor:copy; color:#9ca3af; user-select:none; border-radius:2px;
      }
      ${W} .jv-header:hover .jv-obj-copy { display:inline; }
      ${W} .jv-obj-copy:hover { background:rgba(0,0,0,.08); color:#374151; }
      .dark ${W} .jv-header::before { color:#64748b; }
      .dark ${W} .jv-key     { color:#7dd3fc; }
      .dark ${W} .jv-str     { color:#86efac; }
      .dark ${W} .jv-num     { color:#fca5a5; }
      .dark ${W} .jv-bool    { color:#c4b5fd; }
      .dark ${W} .jv-null    { color:#64748b; }
      .dark ${W} .jv-p       { color:#94a3b8; }
      .dark ${W} .jv-preview { color:#64748b; }
      .dark ${W} .jv-copy:hover { background:rgba(255,255,255,.07); }
      .dark ${W} .jv-obj-copy:hover { background:rgba(255,255,255,.09); color:#e5e7eb; }

      /* Enhanced YAML viewer styles */
      ${W} .ev-yaml-view {
        line-height: 1.7;
      }
      ${W} .yv-row {
        display: block;
        white-space: pre-wrap;
        word-break: break-all;
        overflow-wrap: anywhere;
        line-height: 1.7;
      }
      ${W} .yv-parent { cursor:pointer; border-radius:3px; }
      ${W} .yv-parent:hover { background:rgba(0,0,0,.04); }
      .dark ${W} .yv-parent:hover { background:rgba(255,255,255,.05); }
      ${W} .yv-dash {
        color: #9ca3af;
        margin-right: 0.15rem;
      }
      .dark ${W} .yv-dash {
        color: #64748b;
      }

      /* Key hover effect specific to YAML */
      ${W} .jv-key.jv-copy:hover {
        background: rgba(37, 99, 235, 0.1);
        outline: 1px dashed #2563eb;
      }
      .dark ${W} .jv-key.jv-copy:hover {
        background: rgba(125, 211, 252, 0.1);
        outline: 1px dashed #7dd3fc;
      }
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

    // Prevent the container from growing wider than its natural layout width
    container.style.overflow = 'hidden';

    const data = extractVariables();
    if (!Object.keys(data).length) return false;
    cachedData = data;

    // Inject directly into the existing accordion — no custom accordion wrapper
    const widget = mk('div');
    widget.id = WIDGET_ID;
    widget.style.cssText = 'max-width:80vw; overflow:hidden;';

    const bodyDiv = mk('div');
    bodyDiv.className = 'text-gray-700 dark:text-white text-sm font-mono';

    // Format toggle (segmented control)
    const fmtGroup  = mk('div', 'flex rounded-md shadow-sm');
    const jsonBtn   = mk('button', 'px-4 py-2 text-sm font-medium border border-gray-200 rounded-l-lg bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 focus:z-10 focus:ring-2 focus:ring-gray-500 dark:focus:ring-gray-600', 'JSON');
    const yamlBtn   = mk('button', 'px-4 py-2 text-sm font-medium border border-gray-200 rounded-r-lg bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 focus:z-10 focus:ring-2 focus:ring-gray-500 dark:focus:ring-gray-600', 'YAML');
    jsonBtn.type    = 'button';
    yamlBtn.type    = 'button';

    // Copy button with proper styling
    const copyBtn = mk('button', 'px-4 py-2 text-sm font-medium border border-gray-200 rounded-lg bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 focus:z-10 focus:ring-2 focus:ring-gray-500 dark:focus:ring-gray-600 inline-flex items-center gap-2');
    copyBtn.type = 'button';
    copyBtn.innerHTML = `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 256 256"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg> Copy JSON`;

    // Download button
    const downloadBtn = mk('button', 'px-4 py-2 text-sm font-medium border border-gray-200 rounded-lg bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 focus:z-10 focus:ring-2 focus:ring-gray-500 dark:focus:ring-gray-600 inline-flex items-center gap-2');
    downloadBtn.type = 'button';
    downloadBtn.innerHTML = `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 256 256"><path d="M224,152v56a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V152a8,8,0,0,1,16,0v56H208V152a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,132.69V40a8,8,0,0,0-16,0v92.69L93.66,106.34a8,8,0,0,0-11.32,11.32Z"/></svg> Download .json`;

    const sizeEl = mk('span', 'ml-auto text-xs text-gray-500 dark:text-gray-400');

    const btnCls = 'px-3 py-2 text-sm font-medium border border-gray-200 rounded-lg bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 focus:z-10 focus:ring-2 focus:ring-gray-500 dark:focus:ring-gray-600';
    const collapseAllBtn = mk('button', btnCls, 'Collapse');
    collapseAllBtn.type = 'button';
    collapseAllBtn.title = 'Collapse all';
    const expandAllBtn = mk('button', btnCls, 'Expand');
    expandAllBtn.type = 'button';
    expandAllBtn.title = 'Expand all';

    // Toolbar container
    const toolbar = mk('div', 'flex items-center gap-2 mb-4 flex-wrap');
    toolbar.appendChild(fmtGroup);
    toolbar.appendChild(copyBtn);
    toolbar.appendChild(downloadBtn);
    toolbar.appendChild(collapseAllBtn);
    toolbar.appendChild(expandAllBtn);
    toolbar.appendChild(sizeEl);

    // Content areas
    const treeEl = mk('div');           // JSON interactive tree
    const yamlEl = mk('div');           // YAML viewer (rebuilt on switch)
    yamlEl.style.display = 'none';
    bodyDiv.appendChild(toolbar);
    bodyDiv.appendChild(treeEl);
    bodyDiv.appendChild(yamlEl);

    widget.appendChild(bodyDiv);

    collapseAllBtn.addEventListener('click', () => {
      if (format === 'json') {
        treeEl.querySelectorAll('.jv-header:not(.jv-collapsed)').forEach(h => h.click());
      } else {
        yamlEl.querySelectorAll('.yv-parent').forEach(h => h.classList.add('yv-collapsed'));
        yamlEl.querySelectorAll('[data-yv-depth]').forEach(r => {
          if (+r.dataset.yvDepth > 0) r.style.display = 'none';
        });
      }
    });
    expandAllBtn.addEventListener('click', () => {
      if (format === 'json') {
        treeEl.querySelectorAll('.jv-header.jv-collapsed').forEach(h => h.click());
      } else {
        yamlEl.querySelectorAll('.yv-collapsed').forEach(h => h.classList.remove('yv-collapsed'));
        yamlEl.querySelectorAll('[data-yv-depth]').forEach(r => { r.style.display = ''; });
      }
    });

    function refresh() {
      copyBtn.innerHTML = `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 256 256"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg> Copy`;
      downloadBtn.innerHTML = `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 256 256"><path d="M224,152v56a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V152a8,8,0,0,1,16,0v56H208V152a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,132.69V40a8,8,0,0,0-16,0v92.69L93.66,106.34a8,8,0,0,0-11.32,11.32Z"/></svg> Download`;

      jsonBtn.classList.toggle('bg-gray-300', format === 'json');
      jsonBtn.classList.toggle('dark:bg-gray-600', format === 'json');
      yamlBtn.classList.toggle('bg-gray-300', format === 'yaml');
      yamlBtn.classList.toggle('dark:bg-gray-600', format === 'yaml');

      if (format === 'json') {
        treeEl.replaceChildren(buildNode(cachedData, null, true, ''));
        treeEl.style.display = '';
        yamlEl.style.display = 'none';
        sizeEl.textContent   = `${(toJson(cachedData).length / 1024).toFixed(1)} KB`;
      } else {
        const yaml = toYaml(cachedData);
        yamlEl.replaceChildren(buildYamlView(yaml, cachedData));
        yamlEl.style.display = '';
        treeEl.style.display = 'none';
        sizeEl.textContent   = `${(yaml.length / 1024).toFixed(1)} KB`;
      }
    }

    fmtGroup.appendChild(jsonBtn);
    fmtGroup.appendChild(yamlBtn);

    jsonBtn.addEventListener('click', () => { format = 'json'; refresh(); });
    yamlBtn.addEventListener('click', () => { format = 'yaml'; refresh(); });

    copyBtn.addEventListener('click', async () => {
      const originalText = copyBtn.textContent;
      await copyText(currentText(), copyBtn, 'Copied!');
    });

    downloadBtn.addEventListener('click', () => {
      const pluginId = window.location.pathname.match(/\/plugin_settings\/(\d+)\//)?.[1] ?? 'plugin';
      const isYaml   = format === 'yaml';
      const ext = isYaml ? 'yml' : 'json';
      const a = Object.assign(mk('a'), {
        href:     URL.createObjectURL(new Blob([currentText()], { type: isYaml ? 'text/yaml' : 'application/json' })),
        download: `trmnl-${pluginId}-variables.${ext}`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });

    refresh();

    // Keep the container visible (it provides the dark bg + border styling),
    // but hide the inner variable card list and replace with our widget
    const innerList = container.querySelector('.space-y-3');
    if (innerList) innerList.style.display = 'none';
    container.appendChild(widget);
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
    document.querySelectorAll('[data-controller="variable-fold"] .space-y-3')
      .forEach(el => { el.style.display = ''; });
    document.querySelector('[data-controller="variable-fold"]')?.style.setProperty('overflow', '');
    cachedData = null;
    format     = 'json';
    injectUI();
  });

})();