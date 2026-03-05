// ==UserScript==
// @name         No Floating Sidebar
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.0.0
// @description  Moves the floating bottom sidebar into the top navigation bar and makes it compact.
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings/*/edit*
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'trmnl_view_selector';
  const SELECTOR_ID = 'trmnl-view-selector';

  const VIEW_OPTIONS = [
    { label: 'Shared',          value: ''                      },
    { label: 'Full',            value: 'view--full'            },
    { label: 'Half Horizontal', value: 'view--half_horizontal' },
    { label: 'Half Vertical',   value: 'view--half_vertical'   },
    { label: 'Quadrant',        value: 'view--quadrant'        },
  ];

  const VIEW_TO_SIZE = {
    '':                      'markup_shared',
    'view--full':            'markup_full',
    'view--half_horizontal': 'markup_half_horizontal',
    'view--half_vertical':   'markup_half_vertical',
    'view--quadrant':        'markup_quadrant',
  };

  const VIEW_TO_FILE = {
    '':                      'shared',
    'view--full':            'full',
    'view--half_horizontal': 'half_horizontal',
    'view--half_vertical':   'half_vertical',
    'view--quadrant':        'quadrant',
  };

  // --- State ---
  let active = false;
  let uiInjected = false;

  let _skipPatch = false;
  const DEBUG = true; // Set false to disable logs

  function log(...args) {
    if (DEBUG) console.log('[TRMNL View Selector]', ...args);
  }

  // --- Plugin ID ---
  function getPluginId() {
    const match = window.location.pathname.match(/\/plugin_settings\/(\d+)\//);
    return match ? match[1] : null;
  }

  // --- View files cache ---
  const CACHE_KEY_PREFIX = 'trmnl_views_';
  let viewFilesCache = null;
  let viewFilesPromise = null;

  async function loadViewFiles() {
    if (viewFilesCache) return viewFilesCache;
    const pluginId = getPluginId();
    if (!pluginId) throw new Error('Could not determine plugin ID');
    const cacheKey = CACHE_KEY_PREFIX + pluginId;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        viewFilesCache = JSON.parse(cached);
        return viewFilesCache;
      } catch (e) {}
    }
    const url = `https://trmnl.com/api/plugin_settings/${pluginId}/archive`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch archive: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const files = {};
    const requiredFiles = ['shared', 'full', 'half_horizontal', 'half_vertical', 'quadrant'];
    for (const name of requiredFiles) {
      const fileName = `${name}.liquid`;
      const file = zip.file(fileName);
      files[name] = file ? await file.async('text') : '';
    }
    sessionStorage.setItem(cacheKey, JSON.stringify(files));
    viewFilesCache = files;
    return files;
  }
  viewFilesPromise = loadViewFiles().catch(err => console.warn('[TRMNL] Failed to pre-load view files:', err));

  function getCurrentSize() {
    return new URL(window.location.href).searchParams.get('size');
  }
  function isSharedPage() {
    return getCurrentSize() === 'markup_shared';
  }

  // --- FormData patch (backup for non-fetch submissions, but rarely used) ---
  const _origAppend = FormData.prototype.append;
  FormData.prototype.append = function (name, value) {
    if (_skipPatch) return _origAppend.call(this, name, value);
    if (name === 'markup' && active) {
      const textarea = document.querySelector('[data-codemirror-target="textarea"], [data-markup-editor-target="textarea"]');
      const userMarkup = textarea ? textarea.value : '';
      const viewClass = getViewClass();
      const fileKey = VIEW_TO_FILE[viewClass] || 'shared';
      const viewCode = (viewFilesCache && viewFilesCache[fileKey]) || '';
      value = userMarkup + '\n' + viewCode;
      return _origAppend.call(this, name, value);
    }
    return _origAppend.call(this, name, value);
  };

  const getViewClass = () => localStorage.getItem(STORAGE_KEY) ?? 'view--full';
  const setViewClass = (v) => localStorage.setItem(STORAGE_KEY, v);

  // --- Manual preview refresh (used after dropdown change) ---
  async function refreshPreview() {
    const controllerEl = document.querySelector('[data-codemirror-preview-path-value], [data-markup-editor-preview-path-value]');
    let previewUrl = controllerEl?.dataset?.codemirrorPreviewPathValue
                  ?? controllerEl?.dataset?.markupEditorPreviewPathValue;
    if (!previewUrl) {
      console.warn('[TRMNL View Selector] refreshPreview: preview URL not found');
      return;
    }
    const ourViewClass = getViewClass();
    const sizeParam = VIEW_TO_SIZE[ourViewClass] || 'markup_shared';
    previewUrl = setSizeParam(previewUrl, sizeParam);

    await viewFilesPromise;

    const fileKey = VIEW_TO_FILE[ourViewClass];
    const viewCode = viewFilesCache?.[fileKey] || '';

    const textarea = document.querySelector('[data-codemirror-target="textarea"], [data-markup-editor-target="textarea"]');
    const userMarkup = textarea ? textarea.value : '';

    const controller = document.querySelector('[data-controller="markup-editor"]');
    const sharedMarkup = controller?.dataset?.markupEditorSharedMarkupValue || '';

    const fullMarkup = sharedMarkup + userMarkup + '\n' + viewCode;

    const csrf = document.querySelector("meta[name='csrf-token']")?.content;
    const iframe = document.querySelector('[data-codemirror-target="previewIframe"], [data-markup-editor-target="previewIframe"]');

    if (!iframe || !csrf) {
      console.warn('[TRMNL View Selector] refreshPreview: missing iframe or CSRF token');
      return;
    }

    const fd = new FormData();
    _origAppend.call(fd, 'markup', fullMarkup);
    _origAppend.call(fd, 'authenticity_token', csrf);
    _origAppend.call(fd, 'screen_classes', '');

    try {
      const res = await fetch(previewUrl, { method: 'POST', body: fd });
      iframe.srcdoc = await res.text();
    } catch (err) {
      console.warn('[TRMNL View Selector] Preview refresh failed:', err);
    }
  }

  function setSizeParam(url, sizeValue) {
    const urlObj = new URL(url, window.location.origin);
    urlObj.searchParams.set('size', sizeValue);
    return urlObj.pathname + urlObj.search;
  }

  // --- FETCH INTERCEPTOR (modifies size and appends view template) ---
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    // Only modify when on the shared page
    if (!isSharedPage()) {
      return originalFetch(input, init);
    }

    const request = new Request(input, init);
    const url = request.url;
    const previewRegex = /\/plugin_settings\/\d+\/(?:markup\/)?preview(\?.*)?$/;
    if (request.method === 'POST' && previewRegex.test(url)) {
      log('Intercepted preview request:', url);

      const urlObj = new URL(url, window.location.origin);
      const originalSize = urlObj.searchParams.get('size');

      // Only intervene if the request is for the shared layout
      if (originalSize !== 'markup_shared') {
        log('Skipping – request already has size:', originalSize);
        return originalFetch(request);
      }

      // Avoid reprocessing our own modified requests
      if (urlObj.searchParams.has('_vs_processed')) {
        log('Skipping already processed request');
        return originalFetch(request);
      }

      await viewFilesPromise;

      let originalFormData;
      try {
        originalFormData = await request.clone().formData();
      } catch (e) {
        return originalFetch(request);
      }

      if (originalFormData) {
        _skipPatch = true;
        const newFormData = new FormData();
        for (let [key, value] of originalFormData.entries()) {
          newFormData.append(key, value);
        }

        const selectedClass = getViewClass();
        const targetSize = VIEW_TO_SIZE[selectedClass] || 'markup_shared';

        // Update URL: set size to target and add marker
        urlObj.searchParams.set('size', targetSize);
        urlObj.searchParams.set('_vs_processed', '1'); // prevent loop
        const newUrl = urlObj.toString();
        log('Modified URL:', newUrl);

        // Append view template if a non‑shared view is selected
        if (selectedClass) {
          const originalMarkup = originalFormData.get('markup') || '';
          const fileKey = VIEW_TO_FILE[selectedClass] || 'shared';
          const viewCode = (viewFilesCache && viewFilesCache[fileKey]) || '';
          const textarea = document.querySelector('[data-codemirror-target="textarea"], [data-markup-editor-target="textarea"]');
          const userMarkup = textarea ? textarea.value : '';

          const controller = document.querySelector('[data-controller="markup-editor"]');
          const sharedMarkup = controller?.dataset?.markupEditorSharedMarkupValue || '';

          const fullMarkup = sharedMarkup + userMarkup + '\n' + viewCode;

          newFormData.set('markup', fullMarkup);
          log('Appended view template for', selectedClass);
        }

        // screen_classes left untouched (always empty per user)
        _skipPatch = false;

        // Do NOT copy the original headers; let the browser set the correct Content-Type
        const newRequest = new Request(newUrl, {
          method: request.method,
          body: newFormData,
          credentials: request.credentials,
          referrer: request.referrer,
          referrerPolicy: request.referrerPolicy,
          mode: request.mode,
          cache: request.cache,
          redirect: request.redirect,
          integrity: request.integrity,
          keepalive: request.keepalive,
          signal: request.signal,
        });
        return originalFetch(newRequest);
      }
    }
    return originalFetch(input, init);
  };

  // --- UI Injection ---
  function removeUI() {
    const select = document.getElementById(SELECTOR_ID);
    if (select) {
      const divider = select.nextElementSibling;
      select.remove();
      if (divider?.classList.contains('w-px')) divider.remove();
    }
    uiInjected = false;
  }

  function injectUI() {
    if (uiInjected) return true;
    const resetButton = document.querySelector('[data-reset-button]');
    if (!resetButton) return false;

    const select = document.createElement('select');
    select.id = SELECTOR_ID;
    select.name = 'view_selector';
    select.title = 'Preview view layout';
    select.setAttribute('aria-label', 'Preview view layout');
    select.className = 'inline-block py-2 px-3 min-w-[180px] transition-all duration-200 text-sm font-medium tracking-tight rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-black dark:text-white bg-transparent border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-500';

    const saved = getViewClass();
    for (const { label, value } of VIEW_OPTIONS) {
      const opt = new Option(label, value);
      opt.selected = value === saved;
      select.appendChild(opt);
    }

    const divider = document.createElement('div');
    divider.className = 'w-px bg-gray-300 dark:bg-gray-650 self-stretch';

    resetButton.before(divider);
    divider.before(select);

    select.addEventListener('change', () => {
      setViewClass(select.value);
      refreshPreview();
    });

    // REMOVED: viewFilesPromise.then(() => refreshPreview()); – no double refresh needed

    uiInjected = true;
    console.log('[TRMNL View Selector] injected, view:', saved || '(shared)');
    return true;
  }

  // --- Main: check URL and update UI ---
  function checkAndUpdateUI() {
    const shared = isSharedPage();
    if (shared && !active) {
      active = true;
      injectUI();
    } else if (!shared && active) {
      active = false;
      removeUI();
    } else if (shared && active && !uiInjected) {
      injectUI();
    }
  }

  function startObserver() {
    const observer = new MutationObserver(() => {
      if (active && !uiInjected) injectUI();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30_000);
  }

  document.addEventListener('turbo:load', checkAndUpdateUI);
  document.addEventListener('turbo:render', checkAndUpdateUI);

  checkAndUpdateUI();
  startObserver();
})();

(function() {
    'use strict';

    let styleInjected = false;

    function injectCompactStyle() {
        if (styleInjected) return;
        const style = document.createElement('style');
        style.id = 'moved-nav-compact-style';
        style.textContent = `
            .moved-nav-list {
                padding-top: 0.25rem !important;
                padding-bottom: 0.25rem !important;
            }
            .moved-nav-list a.rounded-lg {
                padding-top: 0.25rem !important;
                padding-bottom: 0.25rem !important;
            }
        `;
        document.head.appendChild(style);
        styleInjected = true;
    }

    function moveSidebar() {
        const floatingSidebar = document.querySelector('nav[aria-label="Sidebar"]');
        if (!floatingSidebar) return false;

        const targetNav = document.querySelector('nav.flex.items-center.justify-between.flex-wrap.w-full');
        if (!targetNav) return false;

        const container = targetNav.querySelector('.flex.items-center.justify-between.w-full');
        if (!container) return false;

        const rightControls = container.querySelector('.flex.items-center.gap-2');
        if (!rightControls) return false;

        const sidebarList = floatingSidebar.querySelector('ul');
        if (!sidebarList) return false;

        // Add our custom class for styling
        sidebarList.classList.add('moved-nav-list', 'ml-4');

        // Insert the list before the right controls
        container.insertBefore(sidebarList, rightControls);

        // Remove the original floating sidebar
        floatingSidebar.remove();

        // Inject the compact CSS if not already present
        injectCompactStyle();

        console.log('Sidebar moved and compacted.');
        return true;
    }

    // Try immediately
    if (moveSidebar()) return;

    // If not ready, observe DOM changes
    const observer = new MutationObserver((mutations, obs) => {
        if (moveSidebar()) {
            obs.disconnect();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
})();