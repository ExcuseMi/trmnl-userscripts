// ==UserScript==
// @name         TRMNL User Stats Badge
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.4.2
// @description  Display user install/fork/connection badges on the right side of the Private Plugin header
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/user-stats-badge.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/user-stats-badge.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const LOG_PREFIX = '[TRMNL User Stats Badge]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);

    const BADGE_ID = 'trmnl-user-stats-badge';
    const TARGET_PATH = '/plugin_settings';
    const TARGET_PARAM = 'keyname=private_plugin';

    function isDarkMode() {
        return document.documentElement.classList.contains('dark');
    }

    function badgeColorParams() {
        return isDarkMode()
            ? 'glyph=white&color=E66100&labelColor=000000'
            : 'glyph=white&color=000000&labelColor=77767B';
    }

    function updateBadgeColors() {
        const img = document.querySelector(`#${BADGE_ID} img[data-badge-base]`);
        if (!img) return;
        img.src = `${img.dataset.badgeBase}&${badgeColorParams()}`;
    }

    new MutationObserver(updateBadgeColors)
        .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    function isTargetPage() {
        return location.pathname === TARGET_PATH && location.search.includes(TARGET_PARAM);
    }

    function onNavigate() {
        if (!isTargetPage()) return;
        log('On target page. URL:', location.href);
        waitForHeader();
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

    function waitForHeader() {
        if (document.getElementById(BADGE_ID)) {
            log('Badge already present, skipping.');
            return;
        }

        if (trySetup()) return;

        const observeTarget = document.querySelector('.flex-grow.sticky.top-14') || document.documentElement;
        log('Header not ready, observing:', observeTarget.tagName, observeTarget.className.slice(0, 60));

        const observer = new MutationObserver(() => {
            if (trySetup()) {
                observer.disconnect();
            }
        });
        observer.observe(observeTarget, { childList: true, subtree: true });
    }

    function trySetup() {
        if (document.getElementById(BADGE_ID)) {
            log('Badge already present, skipping duplicate setup.');
            return true;
        }

        const stickyHeader = document.querySelector('.flex-grow.sticky.top-14');
        if (!stickyHeader) {
            log('Sticky header not found yet (.flex-grow.sticky.top-14).');
            return false;
        }

        const rightContainer = stickyHeader.querySelector('.shrink-0.flex.justify-end.items-end.gap-3');
        if (!rightContainer) {
            log('Right container not found yet (.shrink-0.flex.justify-end.items-end.gap-3).');
            return false;
        }

        const userId = extractUserIdFromIntercom();
        if (!userId) {
            warn('Could not extract user ID from Intercom script.');
            return false;
        }

        log('Setting up badge for user ID:', userId);

        const badgeContainer = document.createElement('div');
        badgeContainer.id = BADGE_ID;
        badgeContainer.className = 'flex items-center gap-2 mr-2 py-2';

        const img = document.createElement('img');
        const badgeBase = `https://trmnl-badges.gohk.xyz/badge/connections?userId=${userId}&pretty`;
        img.dataset.badgeBase = badgeBase;
        img.src = `${badgeBase}&${badgeColorParams()}`;
        img.alt = 'Connections';
        img.className = 'h-5 inline-block';
        badgeContainer.appendChild(img);

        const importBtn = Array.from(rightContainer.children).find(el =>
            el.textContent.trim().toLowerCase().includes('import'));
        if (importBtn) {
            rightContainer.insertBefore(badgeContainer, importBtn);
        } else {
            rightContainer.prepend(badgeContainer);
        }
        log('Badge inserted successfully.');
        return true;
    }

    function extractUserIdFromIntercom() {
        const intercomScript = document.getElementById('IntercomSettingsScriptTag');
        if (!intercomScript) {
            log('IntercomSettingsScriptTag not found.');
            return null;
        }
        const match = intercomScript.innerHTML.match(/"user_id":\s*(\d+)/);
        return match ? match[1] : null;
    }
})();
