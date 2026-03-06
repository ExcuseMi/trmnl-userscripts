// ==UserScript==
// @name         No Floating Sidebar
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @description  Moves the floating bottom sidebar into the top nav and adds a Private Plugins button
// @version      1.3.1
// @description  Moves the floating bottom sidebar
// @author       ExcuseMi
// @match        https://trmnl.com/*
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/no-floating-sidebar.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const MOVED_MARKER = 'data-no-floating-moved';
    const PRIVATE_BUTTON_ID = 'private-plugin-button';

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
        console.log('Sidebar moved and compacted.');

        addPrivatePluginButton(sidebarList); // Add custom button
        return true;
    }

    // Add Private Plugin button dynamically
    function addPrivatePluginButton(ulElement) {
        if (document.getElementById(PRIVATE_BUTTON_ID)) return; // already added

        const li = document.createElement('li');
        li.innerHTML = `
        <a href="/plugin_settings?keyname=private_plugin" id="${PRIVATE_BUTTON_ID}"
           class="flex flex-grow items-center justify-center p-1.5 sm:p-3 rounded-lg bg-transparent text-sm tracking-wide font-medium text-gray-700 dark:text-gray-500 hover:text-primary-500 hover:bg-primary-100 dark:hover:bg-primary-900 transition duration-150"
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
        console.log('Private Plugins button added!');
    }

    // Initial attempt + observer + Turbo events
    injectCompactStyle();
    moveSidebar();

    const observer = new MutationObserver(() => moveSidebar());
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('turbo:load', moveSidebar);
    document.addEventListener('turbo:render', moveSidebar);
})();