// ==UserScript==
// @name         TRMNL Sticky Preview
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.0.3
// @description  Adds a toggle to keep the plugin markup preview sticky while scrolling the editor.
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings/*/markup/edit*
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/sticky-preview.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/sticky-preview.user.js
// @grant        none
// @run-at       document-body
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'trmnl_sticky_preview';
  const STYLE_ID = 'trmnl-sticky-preview-style';
  const BTN_ID = 'trmnl-sticky-preview-toggle';

  function isEnabled() {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  }

  function setEnabled(value) {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  }

  function getStickyHeaderBottom() {
    // The editor page has a sticky sub-header (div.flex-grow.sticky) that sits
    // above the preview/editor columns. Use its bottom edge as the top offset.
    const header = document.querySelector('div.flex-grow.sticky');
    return header ? Math.round(header.getBoundingClientRect().bottom) : 0;
  }

  function applyStyle(enabled) {
    let style = document.getElementById(STYLE_ID);

    if (enabled) {
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      const offset = getStickyHeaderBottom();
      style.textContent = `
        body:has([data-codemirror-target="previewContainer"]) [data-codemirror-target="previewContainer"] {
          position: sticky !important;
          top: ${offset}px !important;
        }
      `;
    } else {
      if (style) style.remove();
    }
  }

  function updateButton(btn, enabled) {
    btn.title = enabled ? 'Disable sticky preview' : 'Enable sticky preview';
    btn.setAttribute('aria-pressed', String(enabled));
    const dot = btn.querySelector('[data-sticky-dot]');
    if (dot) dot.classList.toggle('hidden', !enabled);
  }

  function injectUI() {
    // Guard against double-injection (turbo:load also fires on first page load)
    if (document.getElementById(BTN_ID)) return false;

    const resetBtn = document.querySelector('[data-reset-button]');
    if (!resetBtn) return false;

    const btn = document.createElement('button');

    btn.id = BTN_ID;
    btn.type = 'button';

    // Match the icon-button style used by dark-mode / orientation toggles
    btn.className = [
      'inline-block', 'p-2', 'transition-all', 'duration-200', 'text-sm', 'font-medium',
      'tracking-tight', 'rounded-full', 'hover:bg-gray-100', 'dark:hover:bg-gray-800',
      'text-black', 'dark:text-white', 'bg-transparent', 'border-0', 'cursor-pointer',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-primary-500', 'relative',
    ].join(' ');

    btn.innerHTML = `
<div class="flex items-center gap-2">
  <svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">
    <path d="M235.32,80.84,175.16,20.68a16,16,0,0,0-22.63,0L118.4,55.07c-9.16-1.17-38.3-2.9-63.35,18.81a16,16,0,0,0-.57,23.41L90.56,133.35l-42,42a8,8,0,0,0,11.32,11.31l42-42,36.07,36.07A16,16,0,0,0,149,181.4c.44,0,.88,0,1.32-.06,17.37-1.76,31.65-13.86,38.35-22.62a16,16,0,0,0-.54-21l-4.08-4.08,34.27-34.16A16,16,0,0,0,235.32,80.84Z"/>
  </svg>
  <div data-sticky-dot class="absolute top-1 right-1 w-1.5 h-1.5 bg-primary-600 dark:bg-primary-400 rounded-full hidden"></div>
</div>`;

    const enabled = isEnabled();
    updateButton(btn, enabled);
    applyStyle(enabled);
0
    btn.addEventListener('click', () => {
      const next = !isEnabled();
      setEnabled(next);
      updateButton(btn, next);
      applyStyle(next);
    });

    resetBtn.insertAdjacentElement('afterend', btn);

    // Keep the top offset correct when the header resizes (e.g. window resize)
    const stickyHeader = document.querySelector('div.flex-grow.sticky');
    if (stickyHeader) {
      new ResizeObserver(() => { if (isEnabled()) applyStyle(true); })
        .observe(stickyHeader);
    }

    return true;
  }

  if (!injectUI()) {
    const observer = new MutationObserver(() => {
      if (injectUI()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('turbo:load', injectUI);

})();
