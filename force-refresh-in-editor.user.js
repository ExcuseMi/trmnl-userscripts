// ==UserScript==
// @name         Refresh data in editor
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.0.0
// @description  Add a button to force refresh the data in the editor
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings/*/edit
// @match        https://trmnl.com/plugin_settings/*/markup/edit*
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/force-refresh-in-editor.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/force-refresh-in-editor.user.js
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const pathMatch = location.pathname.match(/plugin_settings\/([^/]+)/);
  if (!pathMatch) return;

  const pluginId = pathMatch[1];
  const storageKey = `trmnl_force_refresh_${pluginId}`;

  function waitFor(selector, callback) {
    const el = document.querySelector(selector);
    if (el) return callback(el);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        callback(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function storeLink() {
    waitFor("#force_refresh a", (a) => {
      const href = a.getAttribute("href");
      if (!href) return;

      localStorage.setItem(storageKey, href);
      console.log("Stored refresh URL:", href);
    });
  }

  function addButton() {
    const href = localStorage.getItem(storageKey);
    if (!href) return;

    waitFor("#markup-tabs", (tabs) => {
      if (document.querySelector(".vm-force-refresh")) return;

      const li = document.createElement("li");
      li.className = "me-2 vm-force-refresh";

      const a = document.createElement("a");
      a.textContent = "Force Refresh Data";
      a.href = "#";
      a.className =
        "inline-flex items-center justify-center p-4 border-b-2 border-transparent hover:text-gray-600 hover:border-gray-300";

      a.onclick = async (e) => {
        e.preventDefault();

        if (!confirm("Force Force Refresh Data for this plugin?")) return;

        await fetch(href, {
          method: "POST",
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest" }
        });
      };

      li.appendChild(a);
      tabs.appendChild(li);
    });
  }

  if (/\/plugin_settings\/[^/]+\/edit$/.test(location.pathname)) {
    storeLink();
  }

  if (/\/plugin_settings\/[^/]+\/markup\/edit/.test(location.pathname)) {
    addButton();
  }
})();