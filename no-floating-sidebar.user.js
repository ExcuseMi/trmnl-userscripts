// ==UserScript==
// @name         No Floating Sidebar (Turbo-Friendly)
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.1.0
// @description  Moves the floating bottom sidebar into the top navigation bar – works with Turbo navigation.
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Marker to avoid moving the same element twice
    const MOVED_MARKER = 'data-no-floating-moved';

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
        `;
        document.head.appendChild(style);
    }

    // Main function: find and move the sidebar
    function moveSidebar() {
        // Find the floating sidebar nav (the one we want to move)
        const floatingSidebar = document.querySelector('nav[aria-label="Sidebar"]');
        if (!floatingSidebar) return false;

        // Skip if we've already moved this exact element
        if (floatingSidebar.hasAttribute(MOVED_MARKER)) return false;

        // Find the top navigation bar – use a more flexible selector
        // Look for a nav that contains both a logo and user menu area
        const topNav = document.querySelector('nav.flex.items-center.justify-between.flex-wrap');
        if (!topNav) return false;

        // The inner container that holds left logo and right controls
        // Often it's a div with classes including "flex items-center justify-between w-full"
        const container = topNav.querySelector('div.flex.items-center.justify-between.w-full');
        if (!container) return false;

        // Find the right‑side controls (user menu, etc.) – use a looser class match
        const rightControls = container.querySelector('[class*="flex items-center gap-"]');
        if (!rightControls) return false;

        // The sidebar's inner list – we'll move the whole nav to preserve tooltips
        // But the nav is the outer element, moving it may be simpler
        // However, moving the whole nav might break layout; better move just the UL
        // We'll extract the UL and its children (including tooltip divs) and insert them
        const sidebarList = floatingSidebar.querySelector('ul');
        if (!sidebarList) return false;

        // Clone the list? No, we move it – but tooltip divs are direct children of the ul?
        // In the provided HTML, tooltips are siblings of <a>, not inside <li>.
        // To keep tooltips working, we must move the entire nav? No, the tooltips are inside the ul as direct children.
        // Moving the ul will move them along, which is fine. But they are absolute positioned;
        // Popper.js may need to reinitialize. However, in practice, moving them while they are hidden
        // and letting Popper recalc on show usually works. We'll proceed.

        // Add our classes and marker
        sidebarList.classList.add('moved-nav-list', 'ml-4');
        sidebarList.setAttribute(MOVED_MARKER, 'true');

        // Insert before the right controls (so it appears between logo and user menu)
        container.insertBefore(sidebarList, rightControls);

        // Remove the original nav (the floating sidebar)
        floatingSidebar.remove();

        // Ensure compact styles are present
        injectCompactStyle();

        console.log('Sidebar moved and compacted.');
        return true;
    }

    // Inject styles early (they are harmless)
    injectCompactStyle();

    // Try immediately in case the DOM is ready
    moveSidebar();

    // Set up a persistent observer to handle Turbo navigations and dynamic changes
    const observer = new MutationObserver(() => {
        // Attempt to move again; the marker prevents double‑moving
        moveSidebar();
    });

    // Observe the entire document for any changes (childList/subtree covers new nodes)
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Optional: also run on Turbo visit (if Turbo is used)
    document.addEventListener('turbo:load', () => {
        moveSidebar();
    });
})();