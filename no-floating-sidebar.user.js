// ==UserScript==
// @name         TRMNL No Floating Sidebar
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @description  Moves the floating bottom sidebar into the top nav and adds a Private Plugins button
// @version      1.4.0
// @description  Moves the floating bottom sidebar
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @icon         https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/refs/heads/main/images/trmnl.svg
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const LOG_PREFIX = '[No Floating Sidebar]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);

    const MOVED_MARKER = 'data-no-floating-moved';
    const PRIVATE_BUTTON_ID = 'private-plugin-button';
    const ANALYTICS_BUTTON_ID = 'analytics-button';

    const NAV_ACTIVE_CLASSES   = ['bg-primary-100', 'dark:bg-primary-900', 'text-primary-500', 'dark:text-primary-500'];
    const NAV_INACTIVE_CLASSES = ['bg-transparent', 'dark:bg-transparent', 'text-gray-700', 'dark:text-gray-500'];

    const ANALYTICS_CACHE_KEY = 'trmnl_analytics_status';
    const ANALYTICS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

    const PLUGIN_STATS_KEY    = 'trmnl_plugin_stats';
    const MARKUP_BADGE_ID     = 'trmnl-markup-stat-badge';

    const SIZE_TO_STAT = {
        markup_full:             'full',
        markup_half_horizontal:  'half_horizontal',
        markup_half_vertical:    'half_vertical',
        markup_quadrant:         'quadrant',
    };
    const SIZE_TO_LABEL = {
        markup_full:             'Full',
        markup_half_horizontal:  'Half Horizontal',
        markup_half_vertical:    'Half Vertical',
        markup_quadrant:         'Quadrant',
    };

    const CUSTOM_NAV_BUTTONS = [
        { id: PRIVATE_BUTTON_ID, pathname: '/plugin_settings', search: 'keyname=private_plugin' },
        { id: ANALYTICS_BUTTON_ID, pathname: '/analytics', search: null },
    ];

    function applyAnalyticsStatus(status) {
        const el = document.getElementById(ANALYTICS_BUTTON_ID);
        if (!el) return;
        el.dataset.analyticsStatus = status;
        log('Analytics status applied:', status);
    }

    async function fetchAndCacheAnalyticsStatus() {
        try {
            const resp = await fetch('/analytics');
            if (!resp.ok) return null;
            const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');

            let hasError = false, hasDegraded = false;

            doc.querySelectorAll('span.text-red-500').forEach(span => {
                if (span.textContent.trim() !== 'Erroring') return;
                const val = span.closest('p')?.nextElementSibling?.nextElementSibling
                    ?.querySelector('span')?.textContent ?? '0';
                if (parseFloat(val) > 0) hasError = true;
            });

            doc.querySelectorAll('span.text-yellow-500').forEach(span => {
                if (span.textContent.trim() !== 'Degraded') return;
                const val = span.closest('p')?.nextElementSibling?.nextElementSibling
                    ?.querySelector('span')?.textContent ?? '0';
                if (parseFloat(val) > 0) hasDegraded = true;
            });

            const status = hasError ? 'error' : hasDegraded ? 'degraded' : 'healthy';
            localStorage.setItem(ANALYTICS_CACHE_KEY, JSON.stringify({ status, ts: Date.now() }));

            // Parse per-plugin layout counts from the "At a Glance" widget
            const pluginStats = {};
            doc.querySelectorAll('.flex.items-center.grow.px-6.py-3.gap-3').forEach(row => {
                const link = row.querySelector('a[href*="/plugin_settings/"][href$="/edit"]');
                if (!link) return;
                const idMatch = link.getAttribute('href').match(/\/plugin_settings\/(\d+)\/edit/);
                if (!idMatch) return;
                const id = idMatch[1];

                const statsText = row.querySelector('p.text-xs span')?.textContent ?? '';
                const pick = label => {
                    const m = statsText.match(new RegExp(label + ':\\s*(\\d+)'));
                    return m ? parseInt(m[1], 10) : 0;
                };
                pluginStats[id] = {
                    full:             pick('Full'),
                    half_vertical:    pick('Half Vertical'),
                    half_horizontal:  pick('Half Horizontal'),
                    quadrant:         pick('Quadrant'),
                };
            });
            if (Object.keys(pluginStats).length) {
                localStorage.setItem(PLUGIN_STATS_KEY, JSON.stringify(pluginStats));
                log('Plugin stats stored for', Object.keys(pluginStats).length, 'plugins.');
            }

            log('Analytics status fetched:', status);
            return status;
        } catch (e) {
            log('Analytics fetch failed:', e.message);
            return null;
        }
    }

    async function checkAnalyticsStatus() {
        let status = null;
        // Always re-fetch when on the analytics page itself so reset/changes are instant
        if (location.pathname !== '/analytics') {
            try {
                const cached = JSON.parse(localStorage.getItem(ANALYTICS_CACHE_KEY));
                if (cached && (Date.now() - cached.ts) < ANALYTICS_CACHE_TTL) status = cached.status;
            } catch (_) {}
        }
        if (!status) status = await fetchAndCacheAnalyticsStatus();
        if (status) applyAnalyticsStatus(status);
    }

    function getMarkupEditContext() {
        const m = location.pathname.match(/\/plugin_settings\/(\d+)\/markup\/edit/);
        if (!m) return null;
        const size = new URLSearchParams(location.search).get('size');
        if (!SIZE_TO_STAT[size]) return null;
        return { pluginId: m[1], statKey: SIZE_TO_STAT[size], label: SIZE_TO_LABEL[size] };
    }

    function injectMarkupStatBadge() {
        const ctx = getMarkupEditContext();

        // Remove badge when navigating away from markup edit pages
        const existing = document.getElementById(MARKUP_BADGE_ID);
        if (!ctx) { existing?.remove(); return true; }

        let count = null;
        try {
            const all = JSON.parse(localStorage.getItem(PLUGIN_STATS_KEY) || '{}');
            if (all[ctx.pluginId]) count = all[ctx.pluginId][ctx.statKey] ?? 0;
        } catch (_) {}

        if (count === null) return false; // no data yet — caller should trigger a fetch

        if (existing) {
            // Update in place when switching sizes on the same plugin
            existing.querySelector('[data-count]').textContent = `${count} on ${ctx.label}`;
            return true;
        }

        const badge = document.createElement('div');
        badge.id = MARKUP_BADGE_ID;
        badge.style.cssText = 'position:fixed;bottom:1.25rem;right:1.25rem;z-index:9999;display:flex;align-items:center;gap:0.375rem;';
        badge.className = 'px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900';
        badge.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" style="width:13px;height:13px;flex-shrink:0">
                <path d="M18 18V2H2v16h16zM16 5H4V4h12v1zM7 7v3h3c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3zm1 2V7c1.1 0 2 .9 2 2H8zm8-1h-4V7h4v1zm0 3h-4V9h4v2zm0 2h-4v-1h4v1zm0 3H4v-1h12v1z"/>
            </svg>
            <span data-count>${count} on ${ctx.label}</span>`;
        document.body.appendChild(badge);
        log(`Markup badge: ${count} instances on ${ctx.label} for plugin ${ctx.pluginId}`);
        return true;
    }

    async function handleMarkupEditPage() {
        if (!getMarkupEditContext()) return;
        if (!injectMarkupStatBadge()) {
            // Stats not cached yet — fetch analytics to populate them
            await fetchAndCacheAnalyticsStatus();
            injectMarkupStatBadge();
        }
    }

    function updateActiveStates() {
        CUSTOM_NAV_BUTTONS.forEach(({ id, pathname, search }) => {
            const el = document.getElementById(id);
            if (!el) return;
            const isActive = location.pathname === pathname &&
                (!search || location.search.includes(search));
            if (isActive) {
                el.classList.remove(...NAV_INACTIVE_CLASSES);
                el.classList.add(...NAV_ACTIVE_CLASSES);
            } else {
                el.classList.remove(...NAV_ACTIVE_CLASSES);
                el.classList.add(...NAV_INACTIVE_CLASSES);
            }
        });
        // When our Private Plugins button is active, deactivate the native /plugins link
        // (the server marks it active for all /plugin_settings pages, causing two highlights)
        const nativePluginsLink = document.querySelector('.moved-nav-list a[href="/plugins"]');
        if (nativePluginsLink) {
            const privatePluginsActive = location.pathname === '/plugin_settings' &&
                location.search.includes('keyname=private_plugin');
            if (privatePluginsActive) {
                nativePluginsLink.classList.remove(...NAV_ACTIVE_CLASSES);
                nativePluginsLink.classList.add(...NAV_INACTIVE_CLASSES);
            }
        }

        // Reapply analytics icon status from cache (button may have been re-injected)
        try {
            const cached = JSON.parse(localStorage.getItem(ANALYTICS_CACHE_KEY));
            if (cached) applyAnalyticsStatus(cached.status);
        } catch (_) {}
    }

    // Inject compact styles once
    function injectCompactStyle() {
        if (document.getElementById('moved-nav-compact-style')) return;
        const style = document.createElement('style');
        style.id = 'moved-nav-compact-style';
        style.textContent = `
            .moved-nav-list {
                padding-top: 0.25rem !important;
                padding-bottom: 0.25rem !important;
            }
            .moved-nav-list a.rounded-lg {
                padding-top: 0.25rem !important;
                padding-bottom: 0.25rem !important;
            }
            #analytics-button[data-analytics-status="error"] svg { color: #ef4444 !important; }
            #analytics-button[data-analytics-status="degraded"] svg { color: #f97316 !important; }
        `;
        document.head.appendChild(style);
    }

    // Find top nav container
    function findTopNavContainer() {
        const topNav = document.querySelector('nav.flex.items-center.justify-between, header');
        if (!topNav) return null;
        const container = topNav.querySelector('div.flex.items-center.justify-between.w-full, div.flex.items-center.justify-between');
        return container || topNav;
    }

    // Find right controls
    function findRightControls(container) {
        let controls = container.querySelector('[class*="flex items-center gap-"]');
        if (controls) return controls;
        const avatar = container.querySelector('img[alt*="avatar" i], img[alt*="profile" i], button[aria-label*="account" i]');
        if (avatar) {
            controls = avatar.closest('[class*="flex items-center"]');
            if (controls) return controls;
        }
        const children = Array.from(container.children);
        return children.find(child => child.querySelector('img[alt*="avatar"], button[class*="user"]')) || children[children.length - 1];
    }

    // Move the floating sidebar
    function moveSidebar() {
        const floatingSidebar = document.querySelector('nav[aria-label="Sidebar"]');
        if (!floatingSidebar) return false;
        if (floatingSidebar.hasAttribute(MOVED_MARKER)) return false;

        const topContainer = findTopNavContainer();
        if (!topContainer) return false;
        const rightControls = findRightControls(topContainer);
        if (!rightControls) return false;

        const sidebarList = floatingSidebar.querySelector('ul');
        if (!sidebarList) return false;

        // Mark and add classes
        sidebarList.classList.add('moved-nav-list', 'ml-4');
        sidebarList.setAttribute(MOVED_MARKER, 'true');

        topContainer.insertBefore(sidebarList, rightControls);
        floatingSidebar.remove();

        injectCompactStyle();
        log('Sidebar moved and compacted.');

        addPrivatePluginButton(sidebarList);
        addAnalyticsButton(sidebarList);
        return true;
    }

    // Add Private Plugin button dynamically
    function addPrivatePluginButton(ulElement) {
        if (document.getElementById(PRIVATE_BUTTON_ID)) return; // already added

        const li = document.createElement('li');
        li.innerHTML = `
        <a href="/plugin_settings?keyname=private_plugin" id="${PRIVATE_BUTTON_ID}"
           class="flex flex-grow items-center justify-center p-1.5 sm:p-3 rounded-lg bg-transparent dark:bg-transparent text-sm tracking-wide font-medium text-gray-700 hover:text-primary-500 dark:text-gray-500 dark:hover:text-primary-500 hover:bg-primary-100 dark:hover:bg-primary-900 transition duration-150"
           data-tooltip-target="tooltip-private">
          <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 256 256"
               class="w-[20px] h-[20px] sm:w-8 sm:h-8 md:w-10 md:h-10" aria-hidden="true">
            <path d="M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Zm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29ZM162.73,32.48a8,8,0,0,0-10.25,4.79l-64,176a8,8,0,0,0,4.79,10.26A8.14,8.14,0,0,0,96,224a8,8,0,0,0,7.52-5.27l64-176A8,8,0,0,0,162.73,32.48Z"/>
          </svg>
          <span class="ml-2 link-text hidden hover:xl:inline">Private Plugins</span>
        </a>
        <div id="tooltip-private" role="tooltip" class="absolute z-10 invisible inline-block px-3 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg shadow-sm opacity-0 tooltip dark:bg-gray-700">
          Private Plugins
          <div class="tooltip-arrow" data-popper-arrow></div>
        </div>
        `;
        ulElement.appendChild(li);
        log('Private Plugins button added!');
        updateActiveStates();
    }

    // Add Analytics button
    function addAnalyticsButton(ulElement) {
        if (document.getElementById(ANALYTICS_BUTTON_ID)) return;

        const li = document.createElement('li');
        li.innerHTML = `
        <a href="/analytics" id="${ANALYTICS_BUTTON_ID}"
           class="flex flex-grow items-center justify-center p-1.5 sm:p-3 rounded-lg bg-transparent dark:bg-transparent text-sm tracking-wide font-medium text-gray-700 hover:text-primary-500 dark:text-gray-500 dark:hover:text-primary-500 hover:bg-primary-100 dark:hover:bg-primary-900 transition duration-150"
           data-tooltip-target="tooltip-analytics">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
               class="w-[20px] h-[20px] sm:w-8 sm:h-8 md:w-10 md:h-10" aria-hidden="true">
            <path d="M18 18V2H2v16h16zM16 5H4V4h12v1zM7 7v3h3c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3zm1 2V7c1.1 0 2 .9 2 2H8zm8-1h-4V7h4v1zm0 3h-4V9h4v2zm0 2h-4v-1h4v1zm0 3H4v-1h12v1z"/>
          </svg>
          <span class="ml-2 link-text hidden hover:xl:inline">Analytics</span>
        </a>
        <div id="tooltip-analytics" role="tooltip" class="absolute z-10 invisible inline-block px-3 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg shadow-sm opacity-0 tooltip dark:bg-gray-700">
          Analytics
          <div class="tooltip-arrow" data-popper-arrow></div>
        </div>
        `;
        ulElement.appendChild(li);
        log('Analytics button added!');
        updateActiveStates();
        checkAnalyticsStatus();
    }

    // Initial attempt + observer + Turbo events
    injectCompactStyle();
    moveSidebar();
    handleMarkupEditPage();

    const observer = new MutationObserver(() => moveSidebar());
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('turbo:load', () => { moveSidebar(); updateActiveStates(); handleMarkupEditPage(); });
    document.addEventListener('turbo:render', () => { moveSidebar(); updateActiveStates(); });
    window.navigation?.addEventListener('navigate', () => setTimeout(() => { moveSidebar(); updateActiveStates(); handleMarkupEditPage(); }, 0));
})();