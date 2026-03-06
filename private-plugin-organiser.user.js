// ==UserScript==
// @name         TRMNL Private Plugin Categorizer
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.1.0
// @description  Add category filters and search to the private plugin page (with persistence, counters, and proper initial styling)
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/private-plugin-organiser.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/private-plugin-organiser.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const LOG_PREFIX = '[TRMNL Organiser]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);

    const FILTER_BAR_ID = 'trmnl-filter-bar';
    const TARGET_PATH = '/plugin_settings';
    const TARGET_PARAM = 'keyname=private_plugin';

    function isTargetPage() {
        return location.pathname === TARGET_PATH && location.search.includes(TARGET_PARAM);
    }

    function onNavigate() {
        if (!isTargetPage()) {
            log('Not on target page, skipping. URL:', location.href);
            return;
        }
        log('On target page, starting observer. URL:', location.href);
        waitForPluginList();
    }

    log('Script loaded. readyState:', document.readyState);

    // Handle Turbo Drive navigation (fires on every Turbo page visit)
    document.addEventListener('turbo:load', () => {
        log('turbo:load fired.');
        onNavigate();
    });

    // Handle regular (non-Turbo) page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            log('DOMContentLoaded fired.');
            onNavigate();
        });
    } else {
        onNavigate();
    }

    // Remove old filter bar when Turbo navigates away, so it doesn't persist in the cache snapshot
    document.addEventListener('turbo:before-visit', () => {
        const existing = document.getElementById(FILTER_BAR_ID);
        if (existing) {
            log('turbo:before-visit — removing filter bar before navigation.');
            existing.remove();
        }
    });

    // Wait for the plugin list to appear in the DOM (handles dynamic/AJAX loading)
    function waitForPluginList() {
        // If already set up, skip
        if (document.getElementById(FILTER_BAR_ID)) {
            log('Filter bar already present, skipping.');
            return;
        }

        const target = document.querySelector('[data-controller="plugin-settings"]') || document.body;
        log('Observing for plugin list on:', target);

        const observer = new MutationObserver(() => {
            if (trySetup()) {
                observer.disconnect();
                log('Observer disconnected after successful setup.');
            }
        });

        observer.observe(target, { childList: true, subtree: true });

        // Also try immediately in case it's already there
        if (trySetup()) {
            observer.disconnect();
            log('Observer disconnected (immediate setup succeeded).');
        }
    }

    function trySetup() {
        const stickyHeader = document.querySelector('.flex-grow.sticky.top-14');
        if (!stickyHeader) {
            log('Sticky header not found yet (.flex-grow.sticky.top-14).');
            return false;
        }

        const listContainer = document.querySelector('[data-controller="plugin-settings"] .flex.flex-col');
        if (!listContainer) {
            log('List container not found yet ([data-controller="plugin-settings"] .flex.flex-col).');
            return false;
        }

        const pluginItems = Array.from(listContainer.querySelectorAll('[data-action*="plugin-settings#editSetting"]'))
            .map(el => el.closest('.flex.items-center.text-sm.cursor-pointer'))
            .filter(row => row);

        if (pluginItems.length === 0) {
            log('No plugin items found yet. Waiting...');
            return false;
        }

        // Already set up (guard against MutationObserver firing multiple times)
        if (document.getElementById(FILTER_BAR_ID)) {
            log('Filter bar already exists, skipping duplicate setup.');
            return true;
        }

        log(`Found ${pluginItems.length} plugin items. Setting up filter bar.`);
        setup(stickyHeader, pluginItems);
        return true;
    }

    function setup(stickyHeader, pluginItems) {
        const plugins = pluginItems.map(row => {
            const titleEl = row.querySelector('h3');
            const title = titleEl ? titleEl.textContent.trim() : '';
            const badgeSpan = row.querySelector('.inline-block.bg-gray-100.text-gray-600.text-xs.font-medium');
            const badge = badgeSpan ? badgeSpan.textContent.trim() : null;
            let category;
            if (badge === 'Recipe Master') category = 'Recipe Master';
            else if (badge === 'Fork') category = 'Fork';
            else if (badge === 'Read Only') category = 'Install';
            else category = 'Private';
            log(`  Plugin: "${title}" | badge: "${badge}" → category: "${category}"`);
            return { row, title, category };
        });

        // Storage helpers
        const STORAGE_KEY_CATEGORY = 'trmnlPluginFilterCategory';
        const STORAGE_KEY_SEARCH = 'trmnlPluginSearchTerm';

        function loadStoredFilters() {
            let category = localStorage.getItem(STORAGE_KEY_CATEGORY) || 'all';
            const validCategories = ['all', 'Recipe Master', 'Fork', 'Install', 'Private'];
            if (!validCategories.includes(category)) category = 'all';
            let searchTerm = localStorage.getItem(STORAGE_KEY_SEARCH) || '';
            log(`Loaded filters from storage: category="${category}", search="${searchTerm}"`);
            return { category, searchTerm };
        }

        function saveFilters(category, searchTerm) {
            localStorage.setItem(STORAGE_KEY_CATEGORY, category);
            localStorage.setItem(STORAGE_KEY_SEARCH, searchTerm);
        }

        let { category: activeCategory, searchTerm } = loadStoredFilters();

        function getButtonClass(category, isActive) {
            const base = 'category-btn px-4 py-2 rounded-full text-sm font-medium transition';
            return isActive
                ? base + ' bg-primary-500 text-white'
                : base + ' bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600';
        }

        const baseLabels = {
            'all': 'All',
            'Recipe Master': 'Recipe Master',
            'Fork': 'Fork',
            'Install': 'Install',
            'Private': 'Private'
        };

        const filterBar = document.createElement('div');
        filterBar.id = FILTER_BAR_ID;
        filterBar.className = 'mt-4 mb-2 w-full';
        filterBar.innerHTML = `
            <div class="flex flex-col sm:flex-row sm:items-center gap-4">
                <!-- Search input -->
                <div class="relative flex-1">
                    <input type="search" id="plugin-search" placeholder="Search plugins..." value="${searchTerm.replace(/"/g, '&quot;')}" class="h-12 w-full px-4 pl-12 rounded-3xl text-black dark:text-white bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition" autocomplete="off">
                    <svg class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-600 fill-current" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56.966 56.966">
                        <path d="M55.146,51.887L41.588,37.786c3.486-4.144,5.396-9.358,5.396-14.786c0-12.682-10.318-23-23-23s-23,10.318-23,23 s10.318,23,23,23c4.761,0,9.298-1.436,13.177-4.162l13.661,14.208c0.571,0.593,1.339,0.92,2.162,0.92 c0.779,0,1.518-0.297,2.079-0.837C56.255,54.982,56.293,53.08,55.146,51.887z M23.984,6c9.374,0,17,7.626,17,17s-7.626,17-17,17 s-17-7.626-17-17S14.61,6,23.984,6z"></path>
                    </svg>
                </div>
                <!-- Category buttons -->
                <div class="flex flex-wrap gap-2" id="category-filters">
                    <button data-category="all" class="${getButtonClass('all', activeCategory === 'all')}">All</button>
                    <button data-category="Recipe Master" class="${getButtonClass('Recipe Master', activeCategory === 'Recipe Master')}">Recipe Master</button>
                    <button data-category="Fork" class="${getButtonClass('Fork', activeCategory === 'Fork')}">Fork</button>
                    <button data-category="Install" class="${getButtonClass('Install', activeCategory === 'Install')}">Install</button>
                    <button data-category="Private" class="${getButtonClass('Private', activeCategory === 'Private')}">Private</button>
                </div>
            </div>
        `;

        const headerContent = stickyHeader.querySelector('.w-full');
        if (headerContent) {
            log('Inserting filter bar after .w-full inside sticky header.');
            headerContent.after(filterBar);
        } else {
            warn('No .w-full found inside sticky header, appending to sticky header directly.');
            stickyHeader.appendChild(filterBar);
        }

        const searchInput = document.getElementById('plugin-search');
        const categoryButtons = document.querySelectorAll('.category-btn');
        log(`Found ${categoryButtons.length} category buttons.`);

        function updateCounts() {
            const term = searchTerm.toLowerCase();
            const counts = { 'all': 0, 'Recipe Master': 0, 'Fork': 0, 'Install': 0, 'Private': 0 };
            plugins.forEach(p => {
                if (!p.title.toLowerCase().includes(term)) return;
                counts.all++;
                counts[p.category]++;
            });
            log('Updated counts:', counts);
            categoryButtons.forEach(btn => {
                const cat = btn.dataset.category;
                btn.textContent = `${baseLabels[cat]} (${counts[cat] || 0})`;
            });
        }

        function applyFilters() {
            let visible = 0, hidden = 0;
            plugins.forEach(p => {
                const matchesCategory = activeCategory === 'all' || p.category === activeCategory;
                const matchesSearch = p.title.toLowerCase().includes(searchTerm.toLowerCase());
                const show = matchesCategory && matchesSearch;
                p.row.style.display = show ? '' : 'none';
                show ? visible++ : hidden++;
            });
            log(`applyFilters: ${visible} visible, ${hidden} hidden (category="${activeCategory}", search="${searchTerm}")`);
        }

        function anyVisible() {
            return plugins.some(p => p.row.style.display !== 'none');
        }

        function resetFilters() {
            warn('No plugins visible with stored filters — resetting to defaults.');
            activeCategory = 'all';
            searchTerm = '';
            searchInput.value = '';
            categoryButtons.forEach(btn => {
                btn.className = getButtonClass(btn.dataset.category, btn.dataset.category === 'all');
            });
            updateCounts();
            saveFilters('all', '');
            applyFilters();
        }

        // Initial state
        updateCounts();
        applyFilters();

        if (!anyVisible()) {
            resetFilters();
        } else {
            saveFilters(activeCategory, searchTerm);
        }

        // Event handlers
        searchInput.addEventListener('input', e => {
            searchTerm = e.target.value;
            log(`Search changed: "${searchTerm}"`);
            saveFilters(activeCategory, searchTerm);
            updateCounts();
            applyFilters();
        });

        categoryButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const category = btn.dataset.category;
                log(`Category button clicked: "${category}"`);
                activeCategory = category;
                saveFilters(activeCategory, searchTerm);
                categoryButtons.forEach(b => {
                    b.className = getButtonClass(b.dataset.category, b.dataset.category === activeCategory);
                });
                applyFilters();
            });
        });

        log('Setup complete.');
    }
})();
