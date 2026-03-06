// ==UserScript==
// @name         TRMNL Master Recipe Badge
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.2
// @description  Add clickable installs and forks badges to Recipe Master plugins on the private plugins page
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings?keyname=private_plugin
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/master-recipe-badge.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/master-recipe-badge.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }

    function setup() {
        // Find all plugin rows (the ones with data-action="click->plugin-settings#editSetting")
        const pluginRows = document.querySelectorAll('[data-action*="plugin-settings#editSetting"]');
        if (pluginRows.length === 0) return;

        pluginRows.forEach(row => {
            // Check if this plugin has the "Recipe Master" badge
            const badgeSpan = row.querySelector('.inline-block.bg-gray-100.text-gray-600.text-xs.font-medium');
            const badgeText = badgeSpan ? badgeSpan.textContent.trim() : null;
            if (badgeText !== 'Recipe Master') return; // Only proceed for Recipe Master

            // Get the plugin ID from the data attribute
            const pluginId = row.getAttribute('data-plugin-settings-id');
            if (!pluginId) return;

            // Find the container for action buttons (the div with flex items-center flex-shrink-0)
            const actionsDiv = row.closest('.flex.items-center.text-sm.cursor-pointer')
                ?.querySelector('.flex.items-center.flex-shrink-0');
            if (!actionsDiv) return;

            // Create badge container
            const badgeContainer = document.createElement('div');
            badgeContainer.className = 'flex items-center gap-1 px-1'; // small horizontal gap

            // --- Installs badge (clickable) ---
            const installsLink = document.createElement('a');
            installsLink.href = `https://trmnl.com/recipes/${pluginId}`;
            installsLink.target = '_blank';       // open in new tab
            installsLink.rel = 'noopener noreferrer'; // security best practice
            const installsImg = document.createElement('img');
            installsImg.src = `https://trmnl-badges.gohk.xyz/badge/connections?recipe=${pluginId}&&pretty`;
            installsImg.alt = 'Installs';
            installsImg.className = 'h-6 w-auto inline-block';
            installsLink.appendChild(installsImg);
            badgeContainer.appendChild(installsLink);


            // Insert the badge container at the beginning of the actions div
            actionsDiv.prepend(badgeContainer);
        });
    }
})();