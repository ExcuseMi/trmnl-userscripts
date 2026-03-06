// ==UserScript==
// @name         TRMNL Recipe Edit Button
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.0.1
// @description  Add an Edit button on recipe pages you own
// @author       ExcuseMi
// @match        https://trmnl.com/recipes/*
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/recipe-edit-button.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/recipe-edit-button.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const LOG_PREFIX = '[TRMNL Recipe Edit]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);

    const EDIT_BTN_ID = 'trmnl-edit-btn';

    function getRecipeId() {
        const match = location.pathname.match(/^\/recipes\/(\d+)$/);
        return match ? match[1] : null;
    }

    function isTargetPage() {
        return getRecipeId() !== null;
    }

    function onNavigate() {
        if (!isTargetPage()) return;
        log('On recipe page. URL:', location.href);
        waitForContent();
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

    function waitForContent() {
        if (document.getElementById(EDIT_BTN_ID)) {
            log('Edit button already present, skipping.');
            return;
        }

        if (trySetup()) return;

        const observeTarget = document.querySelector('.flex.justify-end.items-end.shrink-0') || document.documentElement;
        log('Content not ready, observing:', observeTarget.tagName, observeTarget.className.slice(0, 60));

        const observer = new MutationObserver(() => {
            if (trySetup()) {
                observer.disconnect();
            }
        });
        observer.observe(observeTarget, { childList: true, subtree: true });
    }

    function trySetup() {
        if (document.getElementById(EDIT_BTN_ID)) return true;

        const recipeId = getRecipeId();
        if (!recipeId) return true;

        const buttonContainer = document.querySelector('.flex.justify-end.items-end.shrink-0');
        if (!buttonContainer) {
            log('Button container not found yet (.flex.justify-end.items-end.shrink-0).');
            return false;
        }

        const loggedInUserId = getIntercomUserId();
        if (!loggedInUserId) {
            log('Intercom user ID not available yet.');
            return false;
        }

        // DOM and user ID ready — fetch recipe ownership async
        checkOwnerAndAddButton(recipeId, loggedInUserId, buttonContainer);
        return true; // stop observing, async part handles the rest
    }

    async function checkOwnerAndAddButton(recipeId, loggedInUserId, buttonContainer) {
        log(`Fetching recipe ${recipeId} JSON to check ownership...`);

        let recipeData;
        try {
            const resp = await fetch(`https://trmnl.com/recipes/${recipeId}.json`);
            if (!resp.ok) {
                warn(`Fetch failed: ${resp.status} ${resp.statusText}`);
                return;
            }
            recipeData = await resp.json();
        } catch (err) {
            warn('Error fetching recipe JSON:', err);
            return;
        }

        const recipeUserId = recipeData?.data?.user_id;
        log(`Recipe owner user_id: ${recipeUserId}, logged-in user_id: ${loggedInUserId}`);

        if (String(recipeUserId) !== String(loggedInUserId)) {
            log('Not the recipe owner, no Edit button added.');
            return;
        }

        // Guard: another invocation may have added the button during the fetch
        if (document.getElementById(EDIT_BTN_ID)) {
            log('Edit button already present after fetch, skipping.');
            return;
        }

        const editLink = document.createElement('a');
        editLink.id = EDIT_BTN_ID;
        editLink.href = `/plugin_settings/${recipeId}/edit`;
        editLink.className = 'cursor-pointer font-medium rounded-lg text-sm px-3 py-2 inline-flex items-center transition duration-150 justify-center shrink-0 gap-1.5 whitespace-nowrap text-white bg-primary-500 dark:bg-primary-600 hover:bg-primary-600 dark:hover:bg-primary-500 focus:outline-none ml-3';
        editLink.textContent = 'Edit';

        buttonContainer.prepend(editLink);
        log(`Edit button added → /plugin_settings/${recipeId}/edit`);
    }

    function getIntercomUserId() {
        // Prefer the already-parsed window object (fastest)
        if (window.intercomSettings?.user_id) {
            return String(window.intercomSettings.user_id);
        }
        // Fall back to parsing the raw script tag
        const script = document.getElementById('IntercomSettingsScriptTag');
        if (!script) return null;
        const match = script.innerHTML.match(/"user_id":\s*(\d+)/);
        return match ? match[1] : null;
    }
})();
