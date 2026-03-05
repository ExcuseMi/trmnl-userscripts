// ==UserScript==
// @name         No Floating Sidebar
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.2.0
// @description  Moves the floating bottom sidebar into the top navigation bar – works reliably with Turbo and class variations.
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

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

    // Try to find the top navigation bar container using several common patterns
    function findTopNavContainer() {
        // Look for a nav that contains both a logo and user menu – common patterns
        const topNav = document.querySelector('nav.flex.items-center.justify-between, header');
        if (!topNav) return null;

        // Inside that, find a container that holds both left (logo) and right (user) elements
        // It's often a div with classes including "flex items-center justify-between w-full"
        const container = topNav.querySelector('div.flex.items-center.justify-between.w-full, div.flex.items-center.justify-between');
        return container || topNav; // fallback to the nav itself
    }

    // Find the right‑side controls (user menu, avatar, etc.) – they often contain an image or a specific button
    function findRightControls(container) {
        // Look for a div with class containing "flex items-center gap-" (common for user menu)
        let controls = container.querySelector('[class*="flex items-center gap-"]');
        if (controls) return controls;

        // If not found, look for an element containing a profile avatar (image with alt containing "avatar" or "profile")
        const avatar = container.querySelector('img[alt*="avatar" i], img[alt*="profile" i], button[aria-label*="account" i]');
        if (avatar) {
            // Find the closest parent that likely holds the right controls
            controls = avatar.closest('[class*="flex items-center"]');
            if (controls) return controls;
        }

        // Last resort: return the last child that seems like a menu
        const children = Array.from(container.children);
        return children.find(child => child.querySelector('img[alt*="avatar"], button[class*="user"]')) || children[children.length - 1];
    }

    // Main function to move the sidebar
    function moveSidebar() {
        const floatingSidebar = document.querySelector('nav[aria-label="Sidebar"]');
        if (!floatingSidebar) return false;

        // Skip if we've already moved this exact element (using marker)
        if (floatingSidebar.hasAttribute(MOVED_MARKER)) return false;

        const topContainer = findTopNavContainer();
        if (!topContainer) {
            console.log('Top navigation container not found yet – will retry.');
            return false;
        }

        const rightControls = findRightControls(topContainer);
        if (!rightControls) {
            console.log('Right controls not found – cannot insert sidebar.');
            return false;
        }

        const sidebarList = floatingSidebar.querySelector('ul');
        if (!sidebarList) return false;

        // Mark and add our class
        sidebarList.classList.add('moved-nav-list', 'ml-4');
        sidebarList.setAttribute(MOVED_MARKER, 'true');

        // Insert before the right controls
        topContainer.insertBefore(sidebarList, rightControls);

        // Remove the original floating nav
        floatingSidebar.remove();

        injectCompactStyle();
        console.log('Sidebar moved and compacted.');
        return true;
    }

    // Initial attempt and persistent observer
    injectCompactStyle();
    moveSidebar();

    const observer = new MutationObserver(() => {
        moveSidebar();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Also listen for Turbo navigation events (if Turbo is used)
    document.addEventListener('turbo:load', moveSidebar);
    document.addEventListener('turbo:render', moveSidebar);
})();