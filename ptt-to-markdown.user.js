// ==UserScript==
// @name         PTT to Markdown
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  Downloads a PTT article and comments as a Markdown file.
// @author       You
// @match        https://www.ptt.cc/bbs/*
// @grant        none
// @license      MIT
// ==/UserScript==
(function() {
    'use strict';

    function addStyles() {
        const css = `
            .download-markdown-button {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background-color: #1a73e8;
                color: white;
                border: none;
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
                background-color: #185abc;
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
        const metaTitle = Array.from(document.querySelectorAll('.article-metaline .article-meta-tag'))
            .find(el => el.textContent.trim() === '標題');

        if (metaTitle) {
            const titleValue = metaTitle.nextElementSibling.textContent.trim();
             // Sanitize title for filename, allowing non-ASCII chars but removing illegal filename chars.
            return titleValue.replace(/^Re: /, '').replace(/[\\/:\*?"<>\|]/g, '_').substring(0, 50);
        }

        // Fallback using URL
        const match = window.location.pathname.match(/bbs\/(.+)\/(M\..+\.A\..+)\.html/);
        if (match) {
            return `${match[1]}-${match[2]}`;
        }
        return 'ptt-article';
    }

    function extractContent() {
        const mainContent = document.getElementById('main-content');
        if (!mainContent) {
            console.error("PTT content container '#main-content' not found.");
            return "Error: Could not find PTT content.";
        }

        let markdown = '';
        const meta = {};
        mainContent.querySelectorAll('.article-metaline, .article-metaline-right').forEach(line => {
            const tag = line.querySelector('.article-meta-tag')?.textContent.trim();
            const value = line.querySelector('.article-meta-value')?.textContent.trim();
            if (tag && value) {
                meta[tag] = value;
            }
        });

        // Add frontmatter
        const version = '0.3';
        markdown += `---\n`;
        markdown += `parser: "PTT to Markdown v${version}"\n`;
        markdown += `tags: PTT\n`;
        markdown += `---\n\n`;

        // Add metadata
        markdown += `# ${meta['標題'] || 'No Title'}\n\n`;
        markdown += `**作者:** ${meta['作者'] || 'N/A'}\n`;
        markdown += `**看板:** ${meta['看板'] || 'N/A'}\n`;
        markdown += `**時間:** ${meta['時間'] || 'N/A'}\n\n`;
        markdown += '---\n\n';

        const nodes = Array.from(mainContent.childNodes);
        let inPushBlock = false;
        let textBuffer = '';

        const flushTextBuffer = () => {
            const trimmed = textBuffer.trim();
            if (trimmed) {
                markdown += trimmed + '\n\n';
            }
            textBuffer = '';
        };

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];

            // Skip metadata lines and empty text nodes
            if (node.nodeType === Node.ELEMENT_NODE && node.matches('.article-metaline, .article-metaline-right')) {
                continue;
            }
            if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) {
                continue;
            }

            const isPush = node.nodeType === Node.ELEMENT_NODE && node.matches('.push');
            const isQuote = node.nodeType === Node.ELEMENT_NODE && (node.matches('.f2, .f6'));

            // If we encounter a non-push node while in a push block, end the block.
            if (!isPush && inPushBlock) {
                markdown += '```\n\n';
                inPushBlock = false;
            }

            if (isQuote) {
                flushTextBuffer();
                const quoteText = node.textContent.trim();
                if (quoteText) {
                    markdown += `> ${quoteText}\n`;
                    const nextNode = nodes[i + 1];
                    // Add a newline after a block of quotes
                    if (!nextNode || nextNode.nodeType !== Node.ELEMENT_NODE || !nextNode.matches('.f2, .f6')) {
                       markdown += '\n';
                    }
                }
            } else if (isPush) {
                flushTextBuffer();
                if (!inPushBlock) {
                    markdown += '```\n';
                    inPushBlock = true;
                }
                const tag = node.querySelector('.push-tag')?.textContent.trim() ?? '';
                const user = node.querySelector('.push-userid')?.textContent.trim() ?? '';
                const content = (node.querySelector('.push-content')?.textContent ?? '').replace(/^: /, '').trim();
                const time = node.querySelector('.push-ipdatetime')?.textContent.trim() ?? '';
                markdown += `${tag} ${user} ${content} ${time}\n`;
            } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === '--') {
                 flushTextBuffer();
                 markdown += '---\n\n';
            }
            else {
                textBuffer += node.textContent || '';
            }
        }

        flushTextBuffer();
        if (inPushBlock) {
            markdown += '```\n';
        }

        return markdown.replace(/\n{3,}/g, '\n\n').trim();
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
        if (document.getElementById('main-content')) {
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