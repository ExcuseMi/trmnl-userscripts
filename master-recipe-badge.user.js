// ==UserScript==
// @name         TRMNL Master Recipe Badges
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.4.0
// @description  Add install and forks badges to Recipe Master plugins on list page and edit page
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/master-recipe-badges.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/master-recipe-badges.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const LOG_PREFIX = '[TRMNL Recipe Badges]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);

    // Original list page functionality
    const LIST_PATH = '/plugin_settings';
    const LIST_PARAM = 'keyname=private_plugin';
    const BADGE_ATTR = 'data-trmnl-recipe-badge';

    // Edit page functionality
    const EDIT_PATH_PATTERN = /\/plugin_settings\/(\d+)\/edit/;

    function isListPage() {
        return location.pathname === LIST_PATH && location.search.includes(LIST_PARAM);
    }

    function isEditPage() {
        return EDIT_PATH_PATTERN.test(location.pathname);
    }

    function getPluginIdFromEditUrl() {
        const match = location.pathname.match(EDIT_PATH_PATTERN);
        return match ? match[1] : null;
    }

    // Check if delete button exists on edit page
    function hasDeleteButton() {
        return document.querySelector('button[form="delete_plugin_form"]') !== null;
    }

    // Add badges to edit page in the action buttons container
    function addEditPageBadges(pluginId) {
        // Find the action buttons container
        const actionsContainer = document.querySelector('.flex.justify-start.sm\\:justify-end.items-center.shrink-0.gap-3.flex-wrap');

        if (!actionsContainer) {
            log('Edit page: Actions container not found');
            return false;
        }

        // Check if badges already exist
        if (actionsContainer.querySelector('[data-trmnl-edit-badge]')) {
            return true;
        }

        // Create badges container
        const badgesContainer = document.createElement('div');
        badgesContainer.setAttribute('data-trmnl-edit-badge', 'true');
        badgesContainer.className = 'flex items-center gap-2 mr-2';

        // Create installs badge
        const installsLink = document.createElement('a');
        installsLink.href = `https://trmnl.com/recipes/${pluginId}`;
        installsLink.target = '_blank';
        installsLink.rel = 'noopener noreferrer';
        installsLink.title = 'View recipe installs';

        const installsImg = document.createElement('img');
        installsImg.src = `https://trmnl-badges.gohk.xyz/badge/installs?recipe=${pluginId}&&pretty`;
        installsImg.alt = 'Installs';
        installsImg.className = 'h-6 w-auto inline-block';
        installsLink.appendChild(installsImg);
        badgesContainer.appendChild(installsLink);

        // Create forks badge
        const forksLink = document.createElement('a');
        forksLink.href = `https://trmnl.com/recipes/${pluginId}/forks`;
        forksLink.target = '_blank';
        forksLink.rel = 'noopener noreferrer';
        forksLink.title = 'View recipe forks';

        const forksImg = document.createElement('img');
        forksImg.src = `https://trmnl-badges.gohk.xyz/badge/forks?recipe=${pluginId}&&pretty`;
        forksImg.alt = 'Forks';
        forksImg.className = 'h-6 w-auto inline-block';
        forksLink.appendChild(forksImg);
        badgesContainer.appendChild(forksLink);

        // Insert at the beginning of the actions container
        actionsContainer.insertBefore(badgesContainer, actionsContainer.firstChild);

        log(`Edit page: Installs and forks badges added for plugin ${pluginId}`);
        return true;
    }

    // Handle edit page
    function handleEditPage() {
        const pluginId = getPluginIdFromEditUrl();

        if (!pluginId) {
            log('Edit page: Could not extract plugin ID from URL');
            return;
        }

        if (!hasDeleteButton()) {
            log('Edit page: Delete button not found, adding badges');
            addEditPageBadges(pluginId);
        } else {
            log('Edit page: Delete button found, skipping badges');
        }
    }

    // Original list page functions (copied from your script)
    function waitForPluginList() {
        if (trySetup()) return;

        const observeTarget = document.querySelector('[data-controller="plugin-settings"]') || document.documentElement;
        log('List page: Content not ready, observing:', observeTarget.tagName);

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
            log('List page: No plugin rows found yet.');
            return false;
        }

        let added = 0;
        pluginRows.forEach(row => {
            if (row.hasAttribute(BADGE_ATTR)) return;

            const badgeSpan = row.querySelector('.inline-block.bg-gray-100.text-gray-600.text-xs.font-medium');
            const badgeText = badgeSpan ? badgeSpan.textContent.trim() : null;
            if (badgeText !== 'Recipe Master') {
                row.setAttribute(BADGE_ATTR, 'skipped');
                return;
            }

            const pluginId = row.getAttribute('data-plugin-settings-id');
            if (!pluginId) {
                log('List page: Recipe Master row has no plugin ID, skipping.');
                row.setAttribute(BADGE_ATTR, 'no-id');
                return;
            }

            const actionsDiv = row.closest('.flex.items-center.text-sm.cursor-pointer')
                ?.querySelector('.flex.items-center.flex-shrink-0');
            if (!actionsDiv) {
                log(`List page: Plugin ${pluginId}: actions div not found.`);
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
            installsImg.src = `https://trmnl-badges.gohk.xyz/badge/installs?recipe=${pluginId}&&pretty`;
            installsImg.alt = 'Installs';
            installsImg.className = 'h-6 w-auto inline-block';
            installsLink.appendChild(installsImg);
            badgeContainer.appendChild(installsLink);

            // Add forks badge to list page too
            const forksLink = document.createElement('a');
            forksLink.href = `https://trmnl.com/recipes/${pluginId}/forks`;
            forksLink.target = '_blank';
            forksLink.rel = 'noopener noreferrer';

            const forksImg = document.createElement('img');
            forksImg.src = `https://trmnl-badges.gohk.xyz/badge/forks?recipe=${pluginId}&&pretty`;
            forksImg.alt = 'Forks';
            forksImg.className = 'h-6 w-auto inline-block';
            forksLink.appendChild(forksImg);
            badgeContainer.appendChild(forksLink);

            actionsDiv.prepend(badgeContainer);
            row.setAttribute(BADGE_ATTR, 'done');
            added++;
            log(`List page: Badges added for plugin ${pluginId}.`);
        });

        log(`List page: trySetup: ${added} badge(s) added, ${pluginRows.length} row(s) total.`);
        return true;
    }

    // Main navigation handler
    function onNavigate() {
        if (isListPage()) {
            log('On list page. URL:', location.href);
            waitForPluginList();
        } else if (isEditPage()) {
            log('On edit page. URL:', location.href);
            // Use setTimeout to ensure DOM is ready
            setTimeout(handleEditPage, 100);
        }
    }

    // Start observing for both page types
    log('Script loaded. readyState:', document.readyState);

    document.addEventListener('turbo:load', () => {
        log('turbo:load fired.');
        onNavigate();
    });

    document.addEventListener('turbo:frame-load', () => {
        log('turbo:frame-load fired.');
        onNavigate();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            log('DOMContentLoaded fired.');
            onNavigate();
        });
    } else {
        onNavigate();
    }

    // Observer for dynamic content on edit pages
    const observer = new MutationObserver(() => {
        if (isEditPage()) {
            handleEditPage();
        }
    });

    function startObserving() {
        if (isEditPage()) {
            const target = document.querySelector('main') || document.body;
            observer.observe(target, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserving);
    } else {
        startObserving();
    }
})();