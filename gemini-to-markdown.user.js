// ==UserScript==
// @name         Gemini to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.11.3
// @description  Converts a Gemini chat conversation into a Markdown file, including support for shared chats and canvas content.
// @author       Aiuanyu
// @match        https://gemini.google.com/app/*
// @match        https://gemini.google.com/gem/*
// @match        https://gemini.google.com/share/*
// @grant        none
// @license      MIT
// @history      0.11.3 2026-09-23 - Fixed attachment filename extraction in new Gemini UI (reading button aria-label and filename-label instead of obsolete .new-file-name class).
// @history      0.11.2 2026-09-21 - Filtered out screen reader accessibility labels (cdk-visually-hidden, "你說了" H5) from user queries and model responses.
// @history      0.11.1 2026-09-21 - Fixed scroll container targeting (#chat-history, .chat-history-scroll-container) and extended RPC wait interval for auto-scrolling.
// @history      0.11.0 2026-09-21 - Added Auto-Scroll Collector to automatically scroll up and load full conversation history before exporting.
// @history      0.10.1 2026-09-21 - Filtered out Google Account / user profile elements from title extraction and scoped sidebar selection to conversations list.
// @history      0.10 2026-09-21 - Improved title extraction from active sidebar conversation link and aria-label.
// @history      0.9 2026-08-04 - Fix regression where Gemini's response content was not exported on /share/ pages.
// @history      0.8 2026-08-04 - Avoid exporting duplicate canvas content across turns in Gemini /share pages.
// @history      0.7 2025-11-17 - Added support for shared chats and canvas content.
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.11.3';

    function addStyles() {
        const css = `
            .download-markdown-button {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background-color: #1a73e8;
                color: white;
                border: none;
                border-radius: 28px;
                min-width: 56px;
                height: 56px;
                padding: 0 16px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(0,0,0,0.25);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.25s ease;
                white-space: nowrap;
                user-select: none;
            }
            .download-markdown-button:hover {
                background-color: #185abc;
                box-shadow: 0 6px 16px rgba(0,0,0,0.3);
            }
            .download-markdown-button:disabled {
                background-color: #5f6368;
                cursor: wait;
                opacity: 0.92;
            }
        `;
        const styleSheet = document.createElement("style");
        styleSheet.innerText = css;
        document.head.appendChild(styleSheet);
    }

    function createButton() {
        if (document.querySelector('.download-markdown-button')) return;
        const button = document.createElement("button");
        button.innerText = "MD";
        button.title = "下載為 Markdown（自動載入歷史對話）";
        button.className = "download-markdown-button";
        button.onclick = () => handleExport(button);
        document.body.appendChild(button);
    }

    function sanitizeFilename(title) {
        return (title || 'gemini-chat').replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    function isValidTitle(title) {
        if (!title || typeof title !== 'string') return false;
        const t = title.trim();
        if (t.length < 2) return false;
        if (/Google\s*(?:帳[戶號]|Account)|@|會員方案|Gemini Advanced/i.test(t)) return false;
        if (/^gemini(\.google\.com)?$/i.test(t)) return false;
        return true;
    }

    function getTitle() {
        // 1. If on /share/ page, check h1 strong
        if (window.location.pathname.startsWith('/share/')) {
            const shareTitleEl = document.querySelector('h1 strong, h1');
            if (shareTitleEl && isValidTitle(shareTitleEl.textContent)) {
                return shareTitleEl.textContent.trim();
            }
        }

        // 2. Active chat in sidebar - strictly scoped to conversations-list or gem-nav-list-item
        const currentPath = window.location.pathname;
        const chatIdMatch = currentPath.match(/\/(?:app|gem(?:\/[^\/]+)?)\/([a-zA-Z0-9_-]{8,})/);
        const chatId = chatIdMatch ? chatIdMatch[1] : null;

        if (chatId) {
            const chatLink = document.querySelector(`conversations-list a[href*="${chatId}"], gem-nav-list-item a[href*="${chatId}"], a.gem-nav-list-item[href*="${chatId}"]`);
            if (chatLink) {
                const titleSpan = chatLink.querySelector('.title-text');
                if (titleSpan && isValidTitle(titleSpan.textContent)) {
                    return titleSpan.textContent.trim();
                }
                const label = chatLink.getAttribute('aria-label');
                if (label && isValidTitle(label)) {
                    return label.trim();
                }
            }
        }

        const activeLink = document.querySelector(`
            conversations-list a.is-active,
            conversations-list a.mdc-list-item--activated,
            conversations-list a[aria-current="page"],
            gem-nav-list-item[data-test-id="conversation"] a.is-active,
            gem-nav-list-item[data-test-id="conversation"] a.mdc-list-item--activated
        `);
        if (activeLink) {
            const titleSpan = activeLink.querySelector('.title-text');
            if (titleSpan && isValidTitle(titleSpan.textContent)) {
                return titleSpan.textContent.trim();
            }
            const label = activeLink.getAttribute('aria-label');
            if (label && isValidTitle(label)) {
                return label.trim();
            }
        }

        // 3. Document title without "- Gemini" / "| Gemini"
        if (document.title) {
            const cleaned = document.title
                .replace(/\s*[-|]\s*Gemini.*$/i, '')
                .replace(/^Gemini\s*[-|]\s*/i, '')
                .trim();
            if (isValidTitle(cleaned)) {
                return cleaned;
            }
        }

        // 4. Fallback: First prompt
        const firstPrompt = document.querySelector('.query-text p, .user-query-container p');
        if (firstPrompt && firstPrompt.textContent.trim()) {
            return firstPrompt.textContent.trim().substring(0, 50);
        }

        return 'gemini-chat';
    }

    function parseFilePreview(filePreviewContainer) {
        const filePreviews = filePreviewContainer.querySelectorAll('user-query-file-preview');
        if (filePreviews.length === 0) {
            return '';
        }

        const attachments = Array.from(filePreviews).map(filePreviewElement => {
            // 1. Try button aria-label (modern Gemini UI contains full filename e.g. "20260921-summary.md")
            const button = filePreviewElement.querySelector('button[aria-label]');
            const ariaLabel = button ? button.getAttribute('aria-label').trim() : '';
            if (ariaLabel && !ariaLabel.includes('\n')) {
                return `\`${ariaLabel}\``;
            }

            // 2. Try filename-label + file type
            const labelEl = filePreviewElement.querySelector('[data-test-id="filename-label"], .filename-label');
            const typeEl = filePreviewElement.querySelector('.new-file-type');
            if (labelEl) {
                const baseName = labelEl.textContent.trim();
                const ext = typeEl ? `.${typeEl.textContent.trim().replace(/^\./, '')}` : '';
                return `\`${baseName}${ext}\``;
            }

            // 3. Fallback to legacy selectors (.new-file-name, .new-file-type)
            const fileNameElement = filePreviewElement.querySelector('.new-file-name');
            const fileName = fileNameElement ? fileNameElement.textContent.trim() : 'unknown';
            const fileType = typeEl ? `.${typeEl.textContent.trim().replace(/^\./, '')}` : '';
            return `\`${fileName}${fileType}\``;
        }).filter(Boolean);

        if (attachments.length === 0) return '';
        const label = attachments.length > 1 ? 'Attachments' : 'Attachment';
        return `\n> **${label}:** ${attachments.join(', ')}\n`;
    }

    function parseNode(node, listLevel = 0) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        if (node.classList.contains('file-preview-container')) {
            return parseFilePreview(node);
        }

        if (node.classList.contains('table-footer') ||
            node.classList.contains('cdk-visually-hidden') ||
            node.classList.contains('screen-reader-user-query-label') ||
            node.classList.contains('screen-reader-model-response-label') ||
            (node.tagName.toLowerCase() === 'h5' && /^(你說了|You said)/i.test(node.textContent.trim()))) {
            return '';
        }

        let childMarkdown = '';
        node.childNodes.forEach(child => {
            childMarkdown += parseNode(child, listLevel);
        });

        switch (node.tagName.toLowerCase()) {
            case 'p':
                return `\n\n${childMarkdown.trim()}`;
            case 'h3':
                return `\n\n### ${childMarkdown.trim()}\n\n`;
            case 'h4':
                return `\n\n#### ${childMarkdown.trim()}\n\n`;
            case 'h5':
                return `\n\n##### ${childMarkdown.trim()}\n\n`;
            case 'h6':
                return `\n\n###### ${childMarkdown.trim()}\n\n`;
            case 'b':
            case 'strong':
                return `**${childMarkdown}**`;
            case 'i':
            case 'em':
                return `*${childMarkdown}*`;
            case 'ul':
            case 'ol':
                let listContent = '';
                const indent = '    '.repeat(listLevel);
                Array.from(node.children).forEach((li, i) => {
                    const marker = node.tagName.toLowerCase() === 'ul' ? '*' : `${i + 1}.`;
                    let liText = '';
                    let nestedList = '';
                    li.childNodes.forEach(liChild => {
                        if (liChild.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(liChild.tagName.toLowerCase())) {
                            nestedList += parseNode(liChild, listLevel + 1);
                        } else {
                            liText += parseNode(liChild, listLevel);
                        }
                    });
                    liText = liText.replace(/^\s*\n|\n\s*$/g, '');
                    listContent += `\n${indent}${marker} ${liText}${nestedList}`;
                });
                return listContent;
            case 'li':
                return childMarkdown;
            case 'hr':
                return '\n\n---\n\n';
            case 'code':
                return node.closest('pre') ? childMarkdown : `\`${childMarkdown}\``;
            case 'a':
                return `[${childMarkdown}](${node.href})`;
            case 'code-block':
                return parseCodeBlock(node);
            case 'table':
                return parseTable(node);
            case 'div':
            case 'span':
            case 'message-content':
            case 'user-query':
            case 'query-text':
            case 'response-element':
            case 'body':
            case 'html':
            case 'head':
                return childMarkdown;
            default:
                return childMarkdown;
        }
    }

    function parseCodeBlock(codeBlockElement) {
        const langElement = codeBlockElement.querySelector('.code-block-decoration > span');
        const lang = langElement ? langElement.textContent.trim() : '';
        const codeElement = codeBlockElement.querySelector('code');
        const code = codeElement ? codeElement.textContent : '';
        return `\n\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n\n`;
    }

    function parseTable(tableElement) {
        let markdown = '\n\n';
        const headerRows = tableElement.querySelectorAll('thead tr');
        headerRows.forEach(row => {
            const headers = Array.from(row.querySelectorAll('th, td')).map(cell => parseNode(cell).trim());
            markdown += `| ${headers.join(' | ')} |\n`;
            markdown += `| ${headers.map(() => '---').join(' | ')} |\n`;
        });

        const bodyRows = tableElement.querySelectorAll('tbody tr');
        bodyRows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td')).map(cell => parseNode(cell).trim().replace(/\|/g, '\\|'));
            markdown += `| ${cells.join(' | ')} |\n`;
        });

        return markdown;
    }

    function extractContent() {
        const isSharePage = window.location.pathname.startsWith('/share/') || window.location.pathname.includes('DOM.html') || decodeURIComponent(window.location.pathname).includes('分享');
        const title = getTitle();
        const escapedTitle = title.replace(/"/g, '\\"');

        let markdown = `---
parser: "Gemini to Markdown v${SCRIPT_VERSION}"
title: "${escapedTitle}"
url: "${window.location.href}"
tags:
  - Gemini
`;

        if (isSharePage) {
            const publishTimeElement = document.querySelector('.publish-time');
            if (publishTimeElement) {
                markdown += `published: ${publishTimeElement.textContent.trim()}\n`;
            }
        }
        markdown += `---\n\n`;

        if (isSharePage) {
            const titleElement = document.querySelector('h1 strong');
            if (titleElement) {
                markdown += `# ${titleElement.textContent.trim()}\n\n`;
            }
        } else {
            markdown += `# ${title}\n\n`;
        }

        let turns;
        if (isSharePage) {
            turns = document.querySelectorAll('.chat-history share-turn-viewer');
        } else {
            turns = document.querySelectorAll('.conversation-container');
        }

        if (!turns || turns.length === 0) {
            console.error("Chat content not found.");
            return "Error: Could not find chat content.";
        }

        let userCount = 0;
        let geminiCount = 0;

        // Pre-process canvas containers to identify duplicates
        const canvasInfos = [];
        turns.forEach((turn, index) => {
            const canvasContainer = turn.querySelector('.immersive-artifact-container');
            if (canvasContainer) {
                const canvasTitle = canvasContainer.querySelector('h2.title-text');
                const canvasContent = canvasContainer.querySelector('.immersive-artifact-content');
                if (canvasTitle && canvasContent) {
                    const title = canvasTitle.textContent.trim();
                    const text = canvasContent.textContent.trim();
                    const N = 50;
                    const head = text.substring(0, N);
                    const tail = text.substring(Math.max(0, text.length - N));
                    canvasInfos.push({
                        turnIndex: index,
                        title: title,
                        head: head,
                        tail: tail,
                        isDuplicate: false
                    });
                }
            }
        });

        // Group and mark duplicate ones (except the last occurrence)
        for (let i = 0; i < canvasInfos.length; i++) {
            const current = canvasInfos[i];
            let hasLaterMatching = false;
            for (let j = i + 1; j < canvasInfos.length; j++) {
                const later = canvasInfos[j];
                if (current.title === later.title && current.head === later.head && current.tail === later.tail) {
                    hasLaterMatching = true;
                    break;
                }
            }
            if (hasLaterMatching) {
                current.isDuplicate = true;
            }
        }

        const duplicateMap = new Map();
        canvasInfos.forEach(info => {
            duplicateMap.set(info.turnIndex, info.isDuplicate);
        });

        turns.forEach((turn, index) => {
            const userQuery = turn.querySelector('user-query');
            if (userQuery) {
                userCount++;
                markdown += `## User ${userCount}\n${parseNode(userQuery).trim()}\n\n`;
            }

            const modelResponse = turn.querySelector('.model-response-text') || turn.querySelector('.message-content');
            if (modelResponse) {
                geminiCount++;
                markdown += `## Gemini ${geminiCount}\n`;
                 modelResponse.childNodes.forEach(node => {
                    markdown += parseNode(node);
                });
                markdown += '\n\n';
            }

            const canvasContainer = turn.querySelector('.immersive-artifact-container');
            if (canvasContainer) {
                const canvasTitle = canvasContainer.querySelector('h2.title-text');
                const canvasContent = canvasContainer.querySelector('.immersive-artifact-content');
                if (canvasTitle && canvasContent) {
                    const isDuplicate = duplicateMap.get(index);
                    markdown += `---\n\n## ${canvasTitle.textContent.trim()}\n\n`;
                    if (isDuplicate) {
                        markdown += `最新版詳下\n\n`;
                    } else {
                        canvasContent.childNodes.forEach(node => {
                            markdown += parseNode(node);
                        });
                        markdown += '\n\n';
                    }
                }
            }
        });

        return markdown.replace(/\n{3,}/g, '\n\n').trim();
    }

    function findScrollableContainer() {
        // 1. Direct Gemini chat history container ID and class
        const geminiContainer = document.querySelector('#chat-history, .chat-history-scroll-container');
        if (geminiContainer) {
            return geminiContainer;
        }

        // 2. Active scrolled container with scrollTop > 0
        const candidates = document.querySelectorAll('.chat-history-scroll-container, #chat-history, infinite-scroller, .chat-container, .main-content, main');
        for (const el of candidates) {
            if (el.scrollTop > 0) {
                return el;
            }
        }

        // 3. Parent traversal from first conversation turn
        const firstTurn = document.querySelector('.conversation-container, user-query');
        if (firstTurn) {
            let el = firstTurn.parentElement;
            while (el && el !== document.body && el !== document.documentElement) {
                if (el.scrollHeight > el.clientHeight + 30) {
                    return el;
                }
                el = el.parentElement;
            }
        }

        return document.scrollingElement || document.documentElement || document.body;
    }

    async function autoScrollToTop(button) {
        const scroller = findScrollableContainer();

        const getTurnCount = () => document.querySelectorAll('.conversation-container').length;
        const getFirstTurnSignature = () => {
            const first = document.querySelector('.conversation-container');
            return first ? (first.id || first.textContent.substring(0, 40)) : null;
        };

        const initialCount = getTurnCount();

        // Perform scroll upwards
        const triggerScrollUp = () => {
            // 1. Scroll container directly
            scroller.scrollTop = 0;
            try {
                scroller.scrollTo({ top: 0, behavior: 'smooth' });
            } catch (e) {}

            // 2. Scroll top conversation container into view
            const topTurn = document.querySelector('.conversation-container, user-query');
            if (topTurn && typeof topTurn.scrollIntoView === 'function') {
                topTurn.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }

            // 3. Dispatch scroll events
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            window.dispatchEvent(new Event('scroll', { bubbles: true }));
        };

        let previousCount = initialCount;
        let previousSignature = getFirstTurnSignature();
        let unchangedRounds = 0;
        const maxRounds = 60;
        let round = 0;

        while (round < maxRounds) {
            round++;
            triggerScrollUp();

            if (button) {
                button.innerText = `⏳ 載入中 (${previousCount})...`;
            }

            // Google batchexecute RPC needs ~1.2s to respond and render DOM
            await new Promise(resolve => setTimeout(resolve, 1200));

            const currentCount = getTurnCount();
            const currentSignature = getFirstTurnSignature();

            if (currentCount > previousCount || currentSignature !== previousSignature) {
                unchangedRounds = 0;
                previousCount = currentCount;
                previousSignature = currentSignature;
            } else {
                unchangedRounds++;
                // Wait for at least 2 consecutive confirmations (~2.4s) without new items to be certain
                if (unchangedRounds >= 2) {
                    break;
                }
            }
        }
    }

    function downloadMarkdown() {
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
    }

    let isExporting = false;

    async function handleExport(button) {
        if (isExporting) return;
        isExporting = true;
        button.disabled = true;

        const isSharePage = window.location.pathname.startsWith('/share/') || window.location.pathname.includes('DOM.html') || decodeURIComponent(window.location.pathname).includes('分享');

        try {
            if (!isSharePage) {
                await autoScrollToTop(button);
            }
            button.innerText = '✓ 下載中...';
            downloadMarkdown();
            button.innerText = '✓ 完成';
            setTimeout(() => {
                button.innerText = 'MD';
                button.disabled = false;
                isExporting = false;
            }, 1800);
        } catch (err) {
            console.error('Gemini to Markdown export error:', err);
            button.innerText = '⚠️ 匯出中...';
            downloadMarkdown();
            setTimeout(() => {
                button.innerText = 'MD';
                button.disabled = false;
                isExporting = false;
            }, 2000);
        }
    }

    // Run the script
    const observer = new MutationObserver((mutations, obs) => {
        const isShare = window.location.pathname.startsWith('/share/') || window.location.pathname.includes('DOM.html') || decodeURIComponent(window.location.pathname).includes('分享');
        const readySelector = isShare ? '.chat-history' : '.conversation-container';
        if (document.querySelector(readySelector)) {
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