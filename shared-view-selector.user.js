// ==UserScript==
// @name         Shared View Selector
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.0.1
// @description  Adds a view layout combobox (shared page only). Fetches view templates from plugin archive and injects them into preview requests.
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings/*/markup/edit*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/shared-view-selector.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/shared-view-selector.user.js
// @grant        none
// @run-at       document-body
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
  const DEBUG = false; // Set false to disable logs

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


  const getViewClass = () => localStorage.getItem(STORAGE_KEY) ?? 'view--full';
  const setViewClass = (v) => localStorage.setItem(STORAGE_KEY, v);

  // --- Manual preview refresh (used after dropdown change) ---
  async function refreshPreview() {
    const element = document.querySelector('[data-controller~="codemirror"]');
    if (!element) {
      console.warn('CodeMirror element not found');
      return;
    }

    const controller = window.Stimulus?.getControllerForElementAndIdentifier(element, 'codemirror');
    if (controller) {
      controller.updatePreview();
    } else {
      console.warn('CodeMirror Stimulus controller not found');
    }
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