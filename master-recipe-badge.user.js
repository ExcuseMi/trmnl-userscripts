// ==UserScript==
// @name         TRMNL Master Recipe Badge
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.3.1
// @description  Add clickable installs and forks badges to Recipe Master plugins on the private plugins page
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/master-recipe-badge.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/master-recipe-badge.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const LOG_PREFIX = '[TRMNL Recipe Badge]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);

    const TARGET_PATH = '/plugin_settings';
    const TARGET_PARAM = 'keyname=private_plugin';
    const BADGE_ATTR = 'data-trmnl-recipe-badge';

    function isTargetPage() {
        return location.pathname === TARGET_PATH && location.search.includes(TARGET_PARAM);
    }

    function onNavigate() {
        if (!isTargetPage()) return;
        log('On target page. URL:', location.href);
        waitForPluginList();
    }

    log('Script loaded. readyState:', document.readyState);

    document.addEventListener('turbo:load', () => {
        log('turbo:load fired.');
        onNavigate();
    });

    document.addEventListener('turbo:frame-load', () => {
        log('turbo:frame-load fired.');
        if (!isTargetPage()) return;
        trySetup();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            log('DOMContentLoaded fired.');
            onNavigate();
        });
    } else {
        onNavigate();
    }

    function waitForPluginList() {
        if (trySetup()) return;

        const observeTarget = document.querySelector('[data-controller="plugin-settings"]') || document.documentElement;
        log('Content not ready, observing:', observeTarget.tagName, observeTarget.className.slice(0, 60));

        const observer = new MutationObserver(() => {
            if (trySetup()) {
                observer.disconnect();
            }
        });
        observer.observe(observeTarget, { childList: true, subtree: true });
    }

    function trySetup() {
        const pluginRows = document.querySelectorAll('[data-action*="plugin-settings#editSetting"]');
        if (pluginRows.length === 0) {
            log('No plugin rows found yet.');
            return false;
        }

        let added = 0;
        pluginRows.forEach(row => {
            // Skip rows already processed
            if (row.hasAttribute(BADGE_ATTR)) return;

            const badgeSpan = row.querySelector('.inline-block.bg-gray-100.text-gray-600.text-xs.font-medium');
            const badgeText = badgeSpan ? badgeSpan.textContent.trim() : null;
            if (badgeText !== 'Recipe Master') {
                row.setAttribute(BADGE_ATTR, 'skipped');
                return;
            }

            const pluginId = row.getAttribute('data-plugin-settings-id');
            if (!pluginId) {
                log('Recipe Master row has no plugin ID, skipping.');
                row.setAttribute(BADGE_ATTR, 'no-id');
                return;
            }

            const actionsDiv = row.closest('.flex.items-center.text-sm.cursor-pointer')
                ?.querySelector('.flex.items-center.flex-shrink-0');
            if (!actionsDiv) {
                log(`Plugin ${pluginId}: actions div not found.`);
                row.setAttribute(BADGE_ATTR, 'no-actions');
                return;
            }

            const badgeContainer = document.createElement('div');
            badgeContainer.className = 'flex items-center gap-1 px-1';

            const installsLink = document.createElement('a');
            installsLink.href = `https://trmnl.com/recipes/${pluginId}`;
            installsLink.target = '_blank';
            installsLink.rel = 'noopener noreferrer';

            const installsImg = document.createElement('img');
            installsImg.src = `https://trmnl-badges.gohk.xyz/badge/connections?recipe=${pluginId}&&pretty`;
            installsImg.alt = 'Installs';
            installsImg.className = 'h-6 w-auto inline-block';
            installsLink.appendChild(installsImg);
            badgeContainer.appendChild(installsLink);

            actionsDiv.prepend(badgeContainer);
            row.setAttribute(BADGE_ATTR, 'done');
            added++;
            log(`Badge added for plugin ${pluginId}.`);
        });

        log(`trySetup: ${added} badge(s) added, ${pluginRows.length} row(s) total.`);
        return true; // rows were found, even if none were Recipe Master
    }
})();
