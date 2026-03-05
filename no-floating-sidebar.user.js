// ==UserScript==
// @name         No Floating Sidebar
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.0.2
// @description  Moves the floating bottom sidebar into the top navigation bar and makes it compact.
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @grant        none
// ==/UserScript==
(function() {
    'use strict';

    let styleInjected = false;

    function injectCompactStyle() {
        if (styleInjected) return;
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
        styleInjected = true;
    }

    function moveSidebar() {
        const floatingSidebar = document.querySelector('nav[aria-label="Sidebar"]');
        if (!floatingSidebar) return false;

        const targetNav = document.querySelector('nav.flex.items-center.justify-between.flex-wrap.w-full');
        if (!targetNav) return false;

        const container = targetNav.querySelector('.flex.items-center.justify-between.w-full');
        if (!container) return false;

        const rightControls = container.querySelector('.flex.items-center.gap-2');
        if (!rightControls) return false;

        const sidebarList = floatingSidebar.querySelector('ul');
        if (!sidebarList) return false;

        // Add our custom class for styling
        sidebarList.classList.add('moved-nav-list', 'ml-4');

        // Insert the list before the right controls
        container.insertBefore(sidebarList, rightControls);

        // Remove the original floating sidebar
        floatingSidebar.remove();

        // Inject the compact CSS if not already present
        injectCompactStyle();

        console.log('Sidebar moved and compacted.');
        return true;
    }

    // Try immediately
    if (moveSidebar()) return;

    // If not ready, observe DOM changes
    const observer = new MutationObserver((mutations, obs) => {
        if (moveSidebar()) {
            obs.disconnect();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
})();