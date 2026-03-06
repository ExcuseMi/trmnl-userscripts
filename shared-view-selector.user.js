// ==UserScript==
// @name         TRMNL Shared View Selector
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.1.2
// @description  Adds a view layout combobox (shared page only). Fetches view templates from plugin archive and injects them into preview requests.
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings/*/markup/edit*
// @icon         https://trmnl.com/favicon.ico
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
    { label: 'Shared', value: '' },
    { label: 'Full', value: 'view--full' },
    { label: 'Half Horizontal', value: 'view--half_horizontal' },
    { label: 'Half Vertical', value: 'view--half_vertical' },
    { label: 'Quadrant', value: 'view--quadrant' },
  ];

  const VIEW_TO_SIZE = {
    '': 'markup_shared',
    'view--full': 'markup_full',
    'view--half_horizontal': 'markup_half_horizontal',
    'view--half_vertical': 'markup_half_vertical',
    'view--quadrant': 'markup_quadrant',
  };

  const VIEW_TO_FILE = {
    '': 'shared',
    'view--full': 'full',
    'view--half_horizontal': 'half_horizontal',
    'view--half_vertical': 'half_vertical',
    'view--quadrant': 'quadrant',
  };

  let active = false;
  let uiInjected = false;

  const DEBUG = false;
  function log(...args) {
    if (DEBUG) console.log('[TRMNL View Selector]', ...args);
  }

  function getPluginId() {
    const match = window.location.pathname.match(/\/plugin_settings\/(\d+)\//);
    return match ? match[1] : null;
  }

  const CACHE_KEY_PREFIX = 'trmnl_views_';
  let viewFilesCache = null;
  let viewFilesPromise = null;

  function getCacheKey() {
    const pluginId = getPluginId();
    return pluginId ? CACHE_KEY_PREFIX + pluginId : null;
  }

  function clearViewCache() {
    const key = getCacheKey();
    if (key) sessionStorage.removeItem(key);
    viewFilesCache = null;
    viewFilesPromise = loadViewFiles().catch(err =>
      console.warn('[TRMNL] Failed to reload view files:', err)
    );
    console.log('[TRMNL View Selector] cache cleared');
  }

  async function loadViewFiles() {
    if (viewFilesCache) return viewFilesCache;

    const pluginId = getPluginId();
    if (!pluginId) throw new Error('Could not determine plugin ID');

    const cacheKey = getCacheKey();
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) {
      try {
        viewFilesCache = JSON.parse(cached);
        return viewFilesCache;
      } catch { }
    }

    const url = `https://trmnl.com/api/plugin_settings/${pluginId}/archive`;
    const response = await fetch(url);

    if (!response.ok)
      throw new Error(`Failed to fetch archive: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const files = {};
    const requiredFiles = [
      'shared',
      'full',
      'half_horizontal',
      'half_vertical',
      'quadrant',
    ];

    for (const name of requiredFiles) {
      const fileName = `${name}.liquid`;
      const file = zip.file(fileName);
      files[name] = file ? await file.async('text') : '';
    }

    sessionStorage.setItem(cacheKey, JSON.stringify(files));
    viewFilesCache = files;
    return files;
  }

  viewFilesPromise = loadViewFiles().catch(err =>
    console.warn('[TRMNL] Failed to pre-load view files:', err)
  );

  function getCurrentSize() {
    return new URL(window.location.href).searchParams.get('size');
  }

  function isSharedPage() {
    return getCurrentSize() === 'markup_shared';
  }

  const getViewClass = () => localStorage.getItem(STORAGE_KEY) ?? 'view--full';
  const setViewClass = (v) => localStorage.setItem(STORAGE_KEY, v);

  async function refreshPreview() {
    const element = document.querySelector('[data-controller~="codemirror"]');
    if (!element) return;

    const controller =
      window.Stimulus?.getControllerForElementAndIdentifier(
        element,
        'codemirror'
      );

    if (controller) controller.updatePreview();
  }

  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {

    if (!isSharedPage()) return originalFetch(input, init);

    const request = new Request(input, init);
    const url = request.url;

    const previewRegex = /\/plugin_settings\/\d+\/(?:markup\/)?preview(\?.*)?$/;

    if (request.method === 'POST' && previewRegex.test(url)) {

      const urlObj = new URL(url, window.location.origin);
      const originalSize = urlObj.searchParams.get('size');

      if (originalSize !== 'markup_shared') {
        return originalFetch(request);
      }

      if (urlObj.searchParams.has('_vs_processed')) {
        return originalFetch(request);
      }

      await viewFilesPromise;

      let originalFormData;

      try {
        originalFormData = await request.clone().formData();
      } catch {
        return originalFetch(request);
      }

      if (originalFormData) {

        const newFormData = new FormData();
        for (let [key, value] of originalFormData.entries()) {
          newFormData.append(key, value);
        }

        const selectedClass = getViewClass();
        const targetSize =
          VIEW_TO_SIZE[selectedClass] || 'markup_shared';

        urlObj.searchParams.set('size', targetSize);
        urlObj.searchParams.set('_vs_processed', '1');

        if (selectedClass) {

          const textarea = document.querySelector(
            '[data-codemirror-target="textarea"], [data-markup-editor-target="textarea"]'
          );

          const userMarkup = textarea ? textarea.value : '';

          const controller = document.querySelector(
            '[data-controller="markup-editor"]'
          );

          const sharedMarkup =
            controller?.dataset?.markupEditorSharedMarkupValue || '';

          const fileKey = VIEW_TO_FILE[selectedClass] || 'shared';
          const viewCode =
            (viewFilesCache && viewFilesCache[fileKey]) || '';

          const fullMarkup =
            sharedMarkup + userMarkup + '\n' + viewCode;

          newFormData.set('markup', fullMarkup);
        }

        const newRequest = new Request(urlObj.toString(), {
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

  function removeUI() {

    const select = document.getElementById(SELECTOR_ID);
    const clearBtn = document.getElementById('trmnl-view-clear');

    if (select) select.remove();
    if (clearBtn) clearBtn.remove();

    uiInjected = false;
  }

  function injectUI() {

    if (uiInjected) return true;

    const resetButton = document.querySelector('[data-reset-button]');
    if (!resetButton) return false;

    const select = document.createElement('select');

    select.id = SELECTOR_ID;

    select.className =
      'inline-block py-2 px-3 min-w-[180px] transition-all duration-200 text-sm font-medium tracking-tight rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-black dark:text-white bg-transparent border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-500';

    const saved = getViewClass();

    for (const { label, value } of VIEW_OPTIONS) {

      const opt = new Option(label, value);

      opt.selected = value === saved;

      select.appendChild(opt);

    }

    select.addEventListener('change', () => {

      setViewClass(select.value);

      refreshPreview();

    });

    const clearBtn = document.createElement('button');

    clearBtn.id = 'trmnl-view-clear';

    clearBtn.type = 'button';

    clearBtn.title = 'Clear cached view templates';

    clearBtn.className =
      'inline-flex items-center justify-center ml-1 w-8 h-8 text-sm rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition';

    clearBtn.innerHTML = `
<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none"
viewBox="0 0 24 24" stroke="currentColor">
<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5
4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3m-7 0h8"/>
</svg>`;

    clearBtn.addEventListener('click', async () => {

      clearViewCache();

      await refreshPreview();

    });

    resetButton.before(clearBtn);

    clearBtn.before(select);

    uiInjected = true;

    return true;

  }

  function checkAndUpdateUI() {

    const shared = isSharedPage();

    if (shared && !active) {

      active = true;

      injectUI();

    }

    else if (!shared && active) {

      active = false;

      removeUI();

    }

    else if (shared && active && !uiInjected) {

      injectUI();

    }

  }

  function startObserver() {

    const observer = new MutationObserver(() => {

      if (active && !uiInjected) injectUI();

    });

    observer.observe(document.body, {

      childList: true,

      subtree: true,

    });

    setTimeout(() => observer.disconnect(), 30000);

  }

  document.addEventListener('turbo:load', checkAndUpdateUI);

  document.addEventListener('turbo:render', checkAndUpdateUI);

  window.addEventListener('beforeunload', () => {

    const key = getCacheKey();

    if (key) sessionStorage.removeItem(key);

  });

  checkAndUpdateUI();

  startObserver();

})();