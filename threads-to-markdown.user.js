// ==UserScript==
// @name         Threads to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.2
// @description  Downloads a Threads profile's posts as a Markdown file.
// @author       Aiuanyu & Jules
// @match        https://www.threads.net/*
// @match        https://www.threads.com/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.2';

    function addStyles() {
        const css = `
            .download-markdown-button {
                position: fixed;
                top: 20px;
                right: 20px;
                background-color: #000000;
                color: white;
                border: 1px solid white;
                border-radius: 50%;
                width: 60px;
                height: 60px;
                font-size: 24px;
                cursor: pointer;
                box-shadow: 0 4px 8px rgba(0,0,0,0.2);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .download-markdown-button:hover {
                background-color: #333333;
            }
        `;
        const styleSheet = document.createElement("style");
        styleSheet.innerText = css;
        document.head.appendChild(styleSheet);
    }

    function createButton() {
        const button = document.createElement("button");
        button.innerText = "MD";
        button.title = "Download as Markdown";
        button.className = "download-markdown-button";
        button.onclick = downloadMarkdown;
        document.body.appendChild(button);
    }

    function getSanitizedTitle() {
        const h1 = document.querySelector('h1');
        const authorName = h1 ? h1.textContent.trim() : '';

        const usernameMatch = window.location.pathname.match(/@([^/]+)/);
        const username = usernameMatch ? usernameMatch[1] : 'profile';

        const title = authorName ? `${authorName} (${username})` : username;

        // Sanitize for filename
        return `Threads-${title}`.replace(/[\\/:\*?"<>\|]/g, '_').substring(0, 100);
    }

    function extractContent() {
        const authorName = document.querySelector('h1')?.textContent.trim() || 'N/A';
        const profileUrl = window.location.href;
        const usernameMatch = profileUrl.match(/@([^/]+)/);
        const username = usernameMatch ? usernameMatch[1] : 'N/A';

        let markdown = `---\n`;
        markdown += `parser: "Threads to Markdown v${SCRIPT_VERSION}"\n`;
        markdown += `author: ${authorName}\n`;
        markdown += `username: ${username}\n`;
        markdown += `url: ${profileUrl}\n`;
        markdown += `tags: Threads\n`;
        markdown += `---\n\n`;

        markdown += `# ${authorName} (@${username})\n\n`;

        // Find all potential post containers by looking for a data attribute that seems to mark them,
        // then filter to ensure they are actual posts by checking for a timestamp.
        const postCandidates = document.querySelectorAll('div[data-pressable-container="true"]');
        const postElements = Array.from(postCandidates).filter(el => el.querySelector('time[datetime]'));

        postElements.forEach(post => {
            // Skip if this post is a quoted post inside another post we're already processing.
            if (post.closest('div[role="link"]')) {
                return;
            }

            const timeEl = post.querySelector('time');
            if (!timeEl) return;

            const datetime = timeEl.getAttribute('datetime');
            const postLinkEl = timeEl.closest('a');
            const postUrl = postLinkEl ? postLinkEl.href : 'No permalink found';

            markdown += `## Post from ${new Date(datetime).toISOString()}\n\n`;

            // --- Metadata ---
            const likesEl = post.querySelector('[aria-label="讚"]');
            const likesCount = likesEl ? (likesEl.nextElementSibling?.textContent.trim() || '0') : '0';

            const repliesEl = post.querySelector('[aria-label="回覆"]');
            const repliesCount = repliesEl ? (repliesEl.nextElementSibling?.textContent.trim() || '0') : '0';

            const repostsEl = post.querySelector('[aria-label="轉發"]');
            const repostsCount = repostsEl ? (repostsEl.nextElementSibling?.textContent.trim() || '0') : '0';

            markdown += `**Metadata:**\n`;
            markdown += `- **Permalink:** [${postUrl}](${postUrl})\n`;
            markdown += `- **Likes:** ${likesCount}\n`;
            markdown += `- **Replies:** ${repliesCount}\n`;
            markdown += `- **Shares/Reposts:** ${repostsCount}\n\n`;


            // --- Text Content ---
            const contentContainer = post.querySelector('div > span');
            if (contentContainer) {
                let contentHTML = contentContainer.innerHTML;
                contentHTML = contentHTML.replace(/<br\s*\/?>/gi, '\n');
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = contentHTML;
                const textContent = (tempDiv.textContent || '').trim();
                if (textContent) {
                     markdown += `${textContent}\n\n`;
                }
            }

            // --- Media ---
            const images = post.querySelectorAll('img:not([alt*="大頭貼照"])');
            if (images.length > 0) {
                markdown += `**Media:**\n`;
                images.forEach(img => {
                    const highResSrc = img.srcset?.split(',').map(s => s.trim().split(' ')[0]).pop() || img.src;
                    markdown += `![Image](${highResSrc})\n`;
                });
                markdown += `\n`;
            }
             const videos = post.querySelectorAll('video');
            if (videos.length > 0) {
                if (images.length === 0) markdown += `**Media:**\n`;
                videos.forEach(video => {
                    markdown += `[Video](${video.src})\n`;
                });
                markdown += `\n`;
            }


            // --- Quoted Post ---
            const quoteEl = post.querySelector('div[role="link"]'); // A quoted post is a big link
            if (quoteEl) {
                // Mark it to avoid processing it as a top-level post later
                quoteEl.classList.add('is-quote');

                const quoteLinkEl = quoteEl.querySelector('a[href*="/post/"]');
                const quoteUrl = quoteLinkEl ? quoteLinkEl.href : 'N/A';
                const quoteAuthorEl = quoteEl.querySelector('a[href*="/@"]');
                const quoteAuthor = quoteAuthorEl ? quoteAuthorEl.textContent.trim() : 'N/A';
                const quoteTextEl = quoteEl.querySelector('div > span');
                const quoteText = quoteTextEl ? quoteTextEl.textContent.trim().replace(/\n+/g, ' ') : 'No text';

                markdown += `> [!quote] **${quoteAuthor}**\n`;
                markdown += `> ${quoteText}\n`;
                markdown += `> [Link to quoted post](${quoteUrl})\n\n`;
            }


            markdown += `---\n\n`;
        });


        return markdown;
    }

    function downloadMarkdown() {
        const markdownContent = extractContent();
        const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${getSanitizedTitle()}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Run the script
    const observer = new MutationObserver((mutations, obs) => {
        if (document.querySelector('div[role="region"][aria-label="直欄內文"]')) {
            addStyles();
            createButton();
            obs.disconnect();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

})();