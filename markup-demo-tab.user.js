// ==UserScript==
// @name         TRMNL Markup Demo Tab
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.1.6
// @description  Adds a Demo tab to the markup editor that shows the recipe demo page in an iframe
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings/*/markup/edit*
// @icon         https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/refs/heads/main/images/trmnl.svg
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/markup-demo-tab.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/markup-demo-tab.user.js
// @grant        none
// @run-at       document-body
// ==/UserScript==

(function () {
  'use strict';

  const TAB_ID = 'trmnl-demo-tab';
  const IFRAME_ID = 'trmnl-demo-iframe';
  const STYLE_ID = 'trmnl-demo-tab-style';

  // Elements inside the editor card that are hidden while demo is active
  let hiddenEls = [];

  function getPluginId() {
    const match = window.location.pathname.match(/\/plugin_settings\/(\d+)\//);
    return match ? match[1] : null;
  }

  // The div.border-b that wraps #markup-tabs
  function getTabsRow() {
    return document.getElementById('markup-tabs')?.closest('.border-b');
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #trmnl-demo-iframe-wrap {
        display: none;
      }
      #trmnl-demo-iframe-wrap.active {
        display: block;
        /* Break out of the card's width to use the full viewport */
        width: 100vw;
        margin-left: calc(-50vw + 50%);
        margin-right: calc(-50vw + 50%);
      }
      #${IFRAME_ID} {
        width: 100%;
        border: none;
        display: block;
      }
    `;
    document.head.appendChild(style);
  }

  function getOrCreateIframeWrap() {
    let wrap = document.getElementById('trmnl-demo-iframe-wrap');
    if (wrap) return wrap;

    const tabsRow = getTabsRow();

    // Collect siblings after the tabs row — these are hidden when demo is active
    if (tabsRow) {
      hiddenEls = [];
      let sibling = tabsRow.nextElementSibling;
      while (sibling) {
        hiddenEls.push(sibling);
        sibling = sibling.nextElementSibling;
      }
    }

    wrap = document.createElement('div');
    wrap.id = 'trmnl-demo-iframe-wrap';

    const iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    wrap.appendChild(iframe);

    // Insert inside the card, right after the tabs row
    if (tabsRow) {
      tabsRow.insertAdjacentElement('afterend', wrap);
    } else {
      document.body.appendChild(wrap);
    }

    return wrap;
  }

  function updateIframeHeight(wrap) {
    const iframe = wrap.querySelector(`#${IFRAME_ID}`);
    const top = wrap.getBoundingClientRect().top;
    iframe.style.height = (window.innerHeight - Math.round(top)) + 'px';
  }

  function activateDemo(pluginId) {
    const wrap = getOrCreateIframeWrap();
    const iframe = wrap.querySelector(`#${IFRAME_ID}`);
    const demoUrl = `https://trmnl.com/recipes/${pluginId}/demo`;

    if (iframe.src !== demoUrl) {
      iframe.src = demoUrl;
      iframe.addEventListener('load', () => {
        try {
          const intercom = iframe.contentDocument?.getElementById('intercom-frame');
          if (intercom) intercom.style.setProperty('display', 'none', 'important');
        } catch (_) {}
      }, { once: true });
    }

    hiddenEls.forEach(el => { el.style.display = 'none'; });
    wrap.classList.add('active');
    updateIframeHeight(wrap);

    if (!wrap._resizeListener) {
      wrap._resizeListener = () => updateIframeHeight(wrap);
      window.addEventListener('resize', wrap._resizeListener);
    }
  }

  function deactivateDemo() {
    const wrap = document.getElementById('trmnl-demo-iframe-wrap');
    if (wrap) {
      wrap.classList.remove('active');
      if (wrap._resizeListener) {
        window.removeEventListener('resize', wrap._resizeListener);
        wrap._resizeListener = null;
      }
    }
    hiddenEls.forEach(el => { el.style.display = ''; });
  }

  function injectTab() {
    if (document.getElementById(TAB_ID)) return true;

    const tabList = document.getElementById('markup-tabs');
    if (!tabList) return false;

    const pluginId = getPluginId();
    if (!pluginId) return false;

    const li = document.createElement('li');
    li.id = TAB_ID;
    li.className = 'me-2';

    const a = document.createElement('a');
    a.className = 'inline-flex items-center justify-center p-4 border-b-2 border-transparent [&.active]:border-blue-600 [&.active]:text-blue-600 [&.active]:dark:border-blue-500 [&.active]:dark:text-blue-500 rounded-t-lg hover:text-gray-600 hover:border-gray-300 dark:hover:text-gray-300 group cursor-pointer';
    a.innerHTML = `<svg class="size-6 me-2" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 256 256"><path d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"/></svg>Demo`;

    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (a.classList.contains('active')) return;

      tabList.querySelectorAll('li a').forEach(x => x.classList.remove('active'));
      a.classList.add('active');
      activateDemo(pluginId);
    });

    li.appendChild(a);
    tabList.appendChild(li);

    tabList.querySelectorAll(`li:not(#${TAB_ID}) a`).forEach(otherA => {
      otherA.addEventListener('click', () => {
        a.classList.remove('active');
        deactivateDemo();
      });
    });

    injectStyle();
    return true;
  }

  if (!injectTab()) {
    const observer = new MutationObserver(() => {
      if (injectTab()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('turbo:load', () => {
    hiddenEls = [];
    deactivateDemo();
    injectTab();
  });

})();
