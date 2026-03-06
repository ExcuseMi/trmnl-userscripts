// ==UserScript==
// @name         TRMNL User Stats Badge
// @namespace    https://github.com/ExcuseMi/trmnl-userscripts
// @version      1.2.1
// @description  Display user install/fork/connection badges on the right side of the Private Plugin header
// @author       ExcuseMi
// @match        https://trmnl.com/plugin_settings?keyname=private_plugin*
// @icon         https://trmnl.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/user-stats-badge.user.js
// @updateURL    https://raw.githubusercontent.com/ExcuseMi/trmnl-userscripts/main/user-stats-badge.user.js
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
        const stickyHeader = document.querySelector('.flex-grow.sticky.top-14');
        if (!stickyHeader) return;

        // Find the right-side container that holds the action buttons
        const rightContainer = stickyHeader.querySelector('.shrink-0.flex.justify-end.items-end.gap-3');
        if (!rightContainer) return;

        // Extract user ID from Intercom script
        const userId = extractUserIdFromIntercom();
        if (!userId) return;

        // Create badge container
        const badgeContainer = document.createElement('div');
        badgeContainer.className = 'flex items-center gap-2 mr-2'; // margin-right to separate from buttons

        const baseUrl = 'https://trmnl-badges.gohk.xyz/badge';
        const badges = [
            { type: 'connections', label: 'Connections' }
        ];

        badges.forEach(badge => {
            const img = document.createElement('img');
            img.src = `${baseUrl}/${badge.type}?userId=${userId}&pretty`;
            img.alt = badge.label;
            img.className = 'h-6 inline-block'; // Fixed height class
            badgeContainer.appendChild(img);
        });

        // Insert the badge container at the beginning of the right container
        rightContainer.prepend(badgeContainer);
    }

    function extractUserIdFromIntercom() {
        const intercomScript = document.getElementById('IntercomSettingsScriptTag');
        if (!intercomScript) return null;
        const scriptContent = intercomScript.innerHTML;
        const match = scriptContent.match(/"user_id":\s*(\d+)/);
        return match ? match[1] : null;
    }
})();