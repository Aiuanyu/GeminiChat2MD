// ==UserScript==
// @name         PTT to Markdown
// @namespace    http://tampermonkey.net/
// @version      0.2
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
             // Sanitize title for filename
            return titleValue.replace(/^Re: /, '').replace(/[^a-z0-9_ -]/gi, '_').replace(/ /g, '_').substring(0, 50);
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

        markdown += `# ${meta['標題'] || 'No Title'}\n\n`;
        markdown += `**作者:** ${meta['作者'] || 'N/A'}\n`;
        markdown += `**看板:** ${meta['看板'] || 'N/A'}\n`;
        markdown += `**時間:** ${meta['時間'] || 'N/A'}\n`;
        markdown += '---\n\n';

        const nodes = mainContent.childNodes;
        let inPushBlock = false;
        let textBuffer = '';

        const flushTextBuffer = () => {
            const trimmedBuffer = textBuffer.replace(/[\n\s]+$/, '').replace(/^[\n\s]+/, '');
            if (trimmedBuffer) {
                markdown += trimmedBuffer + '\n\n';
            }
            textBuffer = '';
        };

        for (const node of nodes) {
            if (node.nodeType === Node.ELEMENT_NODE && node.matches('.article-metaline, .article-metaline-right')) {
                continue;
            }

            if (node.nodeType === Node.ELEMENT_NODE && node.matches('.push')) {
                flushTextBuffer();
                if (!inPushBlock) {
                    markdown += '```\n';
                    inPushBlock = true;
                }
                const tag = node.querySelector('.push-tag')?.textContent.trim() ?? '';
                const user = node.querySelector('.push-userid')?.textContent.trim() ?? '';
                const content = node.querySelector('.push-content')?.textContent ?? '';
                const time = node.querySelector('.push-ipdatetime')?.textContent.trim() ?? '';
                markdown += `${tag} ${user}${content} ${time}\n`;
                continue;
            }

            if (inPushBlock) {
                markdown += '```\n\n';
                inPushBlock = false;
            }

            if (node.nodeType === Node.ELEMENT_NODE && (node.matches('.f2, .f6'))) {
                flushTextBuffer();
                let quoteContent = '';
                node.childNodes.forEach(child => {
                    if (child.nodeType === Node.TEXT_NODE) {
                        quoteContent += child.textContent;
                    } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'A') {
                        quoteContent += `[${child.textContent}](${child.href})`;
                    } else {
                        quoteContent += child.textContent;
                    }
                });
                const lines = quoteContent.split('\n').filter(line => line.trim());
                lines.forEach(line => {
                    markdown += `> ${line.trim()}\n`;
                });
                markdown += '\n';
                continue;
            }

            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === '--') {
                flushTextBuffer();
                markdown += '---\n\n';
                continue;
            }

            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
                textBuffer += `[${node.textContent}](${node.href})`;
            } else {
                 if (node.textContent) {
                    textBuffer += node.textContent;
                }
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