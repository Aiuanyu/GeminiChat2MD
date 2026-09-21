// ==UserScript==
// @name         Grok to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.1.0
// @description  Converts a Grok chat conversation into a Markdown file.
// @author       Aiuanyu
// @match        https://grok.com/c/*
// @match        https://grok.com/share/*
// @match        https://grok.com/*
// @grant        none
// @license      MIT
// @history      0.1.0 2026-09-21 - Initial release: supports Grok chat extraction, thinking process (duration & details), code blocks, tables, lists, and sidebar title matching.
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.1.0';

    function addStyles() {
        if (document.getElementById('grok-to-md-styles')) return;
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
                transition: background-color 0.2s, transform 0.1s;
            }
            .download-markdown-button:hover {
                background-color: #185abc;
            }
            .download-markdown-button:active {
                transform: scale(0.95);
            }
        `;
        const styleSheet = document.createElement("style");
        styleSheet.id = 'grok-to-md-styles';
        styleSheet.innerText = css;
        document.head.appendChild(styleSheet);
    }

    function createButton() {
        if (document.querySelector('.download-markdown-button')) return;
        const button = document.createElement("button");
        button.innerText = "MD";
        button.title = "Download as Markdown";
        button.className = "download-markdown-button";
        button.onclick = downloadMarkdown;
        document.body.appendChild(button);
    }

    function getChatId() {
        const match = window.location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
        return match ? match[1] : null;
    }

    function getTitle() {
        const chatId = getChatId();

        // 1. Try to find link in sidebar menu matching current chat UUID
        if (chatId) {
            const activeSidebarSpan = document.querySelector(`ul[data-sidebar="menu"] a[href*="${chatId}"] span, a[href*="${chatId}"] span`);
            if (activeSidebarSpan && activeSidebarSpan.textContent.trim()) {
                return activeSidebarSpan.textContent.trim();
            }
        }

        // 2. Try any active sidebar menu item
        const activeLinkSpan = document.querySelector('ul[data-sidebar="menu"] [data-active="true"] span, ul[data-sidebar="menu"] a.bg-button-ghost-hover span');
        if (activeLinkSpan && activeLinkSpan.textContent.trim()) {
            return activeLinkSpan.textContent.trim();
        }

        // 3. Fallback: document.title without " - Grok" / " | Grok"
        if (document.title) {
            const cleaned = document.title
                .replace(/\s*[-|]\s*Grok.*$/i, '')
                .replace(/^Grok\s*[-|]\s*/i, '')
                .trim();
            if (cleaned && !/^grok(\.com)?$/i.test(cleaned)) {
                return cleaned;
            }
        }

        // 4. Fallback: First user message first line
        const firstUserMsg = document.querySelector('main#grok-content-area [data-testid="user-message"], [data-testid="user-message"]');
        if (firstUserMsg) {
            const firstLine = firstUserMsg.textContent.trim().split('\n')[0].substring(0, 50).trim();
            if (firstLine) return firstLine;
        }

        return 'grok-chat';
    }

    function sanitizeFilename(title) {
        return (title || 'grok-chat').replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    function parseTable(tableElement) {
        let markdown = '\n\n';
        const headerRows = tableElement.querySelectorAll('thead tr');
        if (headerRows.length > 0) {
            headerRows.forEach(row => {
                const headers = Array.from(row.querySelectorAll('th, td')).map(cell => parseNode(cell).trim());
                markdown += `| ${headers.join(' | ')} |\n`;
                markdown += `| ${headers.map(() => '---').join(' | ')} |\n`;
            });
        }

        const bodyRows = tableElement.querySelectorAll('tbody tr');
        bodyRows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td')).map(cell => parseNode(cell).trim().replace(/\|/g, '\\|'));
            markdown += `| ${cells.join(' | ')} |\n`;
        });

        if (headerRows.length === 0 && bodyRows.length === 0) {
            const allRows = tableElement.querySelectorAll('tr');
            allRows.forEach((row, i) => {
                const cells = Array.from(row.querySelectorAll('th, td')).map(cell => parseNode(cell).trim().replace(/\|/g, '\\|'));
                markdown += `| ${cells.join(' | ')} |\n`;
                if (i === 0) {
                    markdown += `| ${cells.map(() => '---').join(' | ')} |\n`;
                }
            });
        }

        return markdown + '\n\n';
    }

    function parseNode(node, listLevel = 0) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        // Ignore hidden assistive elements, icons, or canvas trigger button itself inside body
        if (node.classList && (node.classList.contains('sr-only') || node.classList.contains('not-prose'))) {
            // But keep details/summary or code if relevant
            if (node.tagName.toLowerCase() !== 'details') {
                return '';
            }
        }

        if (node.tagName.toLowerCase() === 'svg') {
            return '';
        }

        if (node.tagName.toLowerCase() === 'details') {
            const summary = node.querySelector('summary');
            const summaryText = summary ? summary.textContent.trim() : 'Details';
            let contentText = '';
            Array.from(node.children).forEach(child => {
                if (child.tagName.toLowerCase() !== 'summary') {
                    contentText += parseNode(child, listLevel) + '\n';
                }
            });
            return `\n\n<details><summary>${summaryText}</summary>\n\n${contentText.trim()}\n\n</details>\n\n`;
        }

        let childMarkdown = '';
        node.childNodes.forEach(child => {
            childMarkdown += parseNode(child, listLevel);
        });

        switch (node.tagName.toLowerCase()) {
            case 'p':
                return `\n\n${childMarkdown.trim()}`;
            case 'h1':
                return `\n\n# ${childMarkdown.trim()}\n\n`;
            case 'h2':
                return `\n\n## ${childMarkdown.trim()}\n\n`;
            case 'h3':
                return `\n\n### ${childMarkdown.trim()}\n\n`;
            case 'h4':
                return `\n\n#### ${childMarkdown.trim()}\n\n`;
            case 'h5':
                return `\n\n##### ${childMarkdown.trim()}\n\n`;
            case 'h6':
                return `\n\n###### ${childMarkdown.trim()}\n\n`;
            case 'strong':
            case 'b':
                return `**${childMarkdown}**`;
            case 'em':
            case 'i':
                return `*${childMarkdown}*`;
            case 'del':
            case 's':
            case 'strike':
                return `~~${childMarkdown}~~`;
            case 'blockquote':
                const quoteLines = childMarkdown.trim().split('\n').map(line => `> ${line}`);
                return `\n\n${quoteLines.join('\n')}\n\n`;
            case 'hr':
                return `\n\n---\n\n`;
            case 'pre':
                const codeEl = node.querySelector('code');
                const codeText = codeEl ? codeEl.textContent : node.textContent;
                let lang = '';
                if (codeEl && codeEl.className) {
                    const match = codeEl.className.match(/language-(\w+)/);
                    if (match) lang = match[1];
                }
                return `\n\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n\n`;
            case 'code':
                if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
                    return node.textContent;
                }
                return `\`${childMarkdown.trim()}\``;
            case 'table':
                return parseTable(node);
            case 'ul':
                return `\n\n${childMarkdown}\n\n`;
            case 'ol':
                return `\n\n${childMarkdown}\n\n`;
            case 'li':
                const indent = '  '.repeat(listLevel);
                const parent = node.parentElement;
                let bullet = '- ';
                if (parent && parent.tagName.toLowerCase() === 'ol') {
                    const index = Array.from(parent.children).indexOf(node) + 1;
                    bullet = `${index}. `;
                }
                let liText = '';
                node.childNodes.forEach(child => {
                    if (child.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
                        liText += '\n' + parseNode(child, listLevel + 1);
                    } else {
                        liText += parseNode(child, listLevel);
                    }
                });
                return `${indent}${bullet}${liText.trim()}\n`;
            case 'a':
                const href = node.getAttribute('href');
                if (href) {
                    return `[${childMarkdown.trim()}](${href})`;
                }
                return childMarkdown;
            case 'img':
                const src = node.getAttribute('src');
                const alt = node.getAttribute('alt') || 'image';
                if (src) {
                    return `![${alt}](${src})`;
                }
                return '';
            case 'br':
                return '\n';
            default:
                return childMarkdown;
        }
    }

    function parseUserTurn(turnNode) {
        const contentContainer = turnNode.querySelector('.response-content-markdown') || turnNode;
        return parseNode(contentContainer).trim();
    }

    function parseGrokTurn(turnNode) {
        let result = '';

        // Check for thinking process container
        const thinkingContainer = turnNode.querySelector('.thinking-container');
        if (thinkingContainer) {
            const trigger = thinkingContainer.querySelector('[data-testid="canvas-trigger"]');
            const duration = trigger ? trigger.textContent.trim() : '';

            // Check if there is expanded thinking body
            const thinkingBody = thinkingContainer.querySelector('[aria-hidden="false"]') || thinkingContainer.querySelector('.prose');
            const thinkingText = thinkingBody ? parseNode(thinkingBody).trim() : '';

            if (thinkingText) {
                result += `<details><summary>Thinking Process${duration ? ` (${duration})` : ''}</summary>\n\n${thinkingText}\n\n</details>\n\n`;
            } else if (duration) {
                result += `> *Thinking Process: ${duration}*\n\n`;
            }
        }

        const contentContainer = turnNode.querySelector('.response-content-markdown') || turnNode;
        const mainText = parseNode(contentContainer).trim();
        if (mainText) {
            result += mainText;
        }

        return result.trim();
    }

    function extractContent() {
        const title = getTitle();
        const escapedTitle = title.replace(/"/g, '\\"');

        let markdown = `---
parser: "Grok to Markdown v${SCRIPT_VERSION}"
title: "${escapedTitle}"
url: "${window.location.href}"
tags:
  - Grok
---

# ${title}

`;

        const container = document.querySelector('main#grok-content-area') || document;
        const allElements = Array.from(container.querySelectorAll(`
            [data-testid="user-message"], 
            [data-testid="assistant-message"]
        `));

        let userCount = 0;
        let grokCount = 0;

        allElements.forEach(el => {
            const isUser = el.getAttribute('data-testid') === 'user-message';
            if (isUser) {
                userCount++;
                const text = parseUserTurn(el);
                markdown += `## User ${userCount}\n\n${text}\n\n`;
            } else {
                grokCount++;
                const text = parseGrokTurn(el);
                markdown += `## Grok ${grokCount}\n\n${text}\n\n`;
            }
        });

        if (userCount === 0 && grokCount === 0) {
            console.error("[Grok to Markdown] Chat content not found.");
            return "Error: Could not find chat content.";
        }

        return markdown.replace(/\n{3,}/g, '\n\n').trim();
    }

    function downloadMarkdown() {
        const button = document.querySelector('.download-markdown-button');
        const originalText = button ? button.innerText : 'MD';
        if (button) {
            button.innerText = '⏳';
            button.style.pointerEvents = 'none';
        }

        try {
            const title = getTitle();
            const markdownContent = extractContent();
            const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${sanitizeFilename(title)}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error("[Grok to Markdown] Download failed:", err);
            alert("匯出 Markdown 失敗，請開啟 Console 檢視錯誤。");
        } finally {
            if (button) {
                button.innerText = originalText;
                button.style.pointerEvents = 'auto';
            }
        }
    }

    // Observe DOM for button insertion
    const observer = new MutationObserver(() => {
        const readySelector = 'main#grok-content-area, [data-testid="user-message"], [data-testid="assistant-message"]';
        if (document.querySelector(readySelector)) {
            addStyles();
            createButton();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    window.addEventListener('load', () => {
        addStyles();
        createButton();
    });

})();
