// ==UserScript==
// @name         Gemini to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.15.0
// @description  Converts a Gemini chat conversation into a Markdown file, including support for shared chats and canvas content.
// @author       Aiuanyu
// @match        https://gemini.google.com/app/*
// @match        https://gemini.google.com/gem/*
// @match        https://gemini.google.com/share/*
// @grant        none
// @license      MIT
// @history      0.15.0 2026-11-02 - Wrapped raw non-fenced inline HTML tags across chat messages and Canvas in Markdown code format to ensure proper display in Obsidian.
// @history      0.14.0 2026-11-01 - Rendered inline Obsidian Canvas placeholder links ([[#Title|Canvas 全文詳下]]) in conversation flow and consolidated full Canvas documents at document bottom.
// @history      0.13.1 2026-11-01 - Filtered out Canvas container elements (immersive-entry-chip, inline-preview, gem-processing-card) during model response traversal to prevent duplicate export and UI leaks (buttons, titles).
// @history      0.13.0 2026-11-01 - Supported modern Gemini Canvas/Artifact structures (inline-preview, gem-processing-card, immersive-editor/ProseMirror) with intelligent duplicate detection.
// @history      0.12.0 2026-10-16 - Added support for H1/H2 headings in model responses with adaptive heading demotion (demoteHeadings); stripped " - Google Gemini" suffix from document title and download filename.
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

    const SCRIPT_VERSION = '0.15.0';
    let latestCanvasMap = new Map();
    let currentTurnIndex = -1;

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

    function cleanTitle(rawTitle) {
        if (!rawTitle || typeof rawTitle !== 'string') return '';
        return rawTitle
            .replace(/\s*[-|]\s*(Google\s+)?Gemini.*$/i, '')
            .replace(/^(Google\s+)?Gemini\s*[-|]\s*/i, '')
            .trim();
    }

    function sanitizeFilename(title) {
        const cleaned = cleanTitle(title);
        return (cleaned || 'gemini-chat').replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    function isValidTitle(title) {
        if (!title || typeof title !== 'string') return false;
        const t = title.trim();
        if (t.length < 2) return false;
        if (/Google\s*(?:帳[戶號]|Account)|@|會員方案|Gemini Advanced/i.test(t)) return false;
        if (/^(Google\s+)?gemini(\.google\.com)?$/i.test(t)) return false;
        return true;
    }

    function getTitle() {
        // 1. If on /share/ page, check h1 strong
        if (window.location.pathname.startsWith('/share/')) {
            const shareTitleEl = document.querySelector('h1 strong, h1');
            if (shareTitleEl) {
                const cleaned = cleanTitle(shareTitleEl.textContent);
                if (isValidTitle(cleaned)) {
                    return cleaned;
                }
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
                if (titleSpan) {
                    const cleaned = cleanTitle(titleSpan.textContent);
                    if (isValidTitle(cleaned)) {
                        return cleaned;
                    }
                }
                const label = chatLink.getAttribute('aria-label');
                if (label) {
                    const cleaned = cleanTitle(label);
                    if (isValidTitle(cleaned)) {
                        return cleaned;
                    }
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
            if (titleSpan) {
                const cleaned = cleanTitle(titleSpan.textContent);
                if (isValidTitle(cleaned)) {
                    return cleaned;
                }
            }
            const label = activeLink.getAttribute('aria-label');
            if (label) {
                const cleaned = cleanTitle(label);
                if (isValidTitle(cleaned)) {
                    return cleaned;
                }
            }
        }

        // 3. Document title without "- Google Gemini" / "- Gemini" / "| Gemini"
        if (document.title) {
            const cleaned = cleanTitle(document.title);
            if (isValidTitle(cleaned)) {
                return cleaned;
            }
        }

        // 4. Fallback: First prompt
        const firstPrompt = document.querySelector('.query-text p, .user-query-container p');
        if (firstPrompt && firstPrompt.textContent.trim()) {
            const cleaned = cleanTitle(firstPrompt.textContent.trim().substring(0, 50));
            if (isValidTitle(cleaned)) {
                return cleaned;
            }
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

        const tag = node.tagName.toLowerCase();
        if (tag === 'immersive-entry-chip' ||
            tag === 'inline-preview' ||
            tag === 'gem-processing-card' ||
            node.classList.contains('immersive-artifact-container')) {
            const titleEl = node.querySelector('.card-title, .title, h2.title-text, h2');
            const canvasTitle = titleEl ? titleEl.textContent.trim() : '';
            const targetKeeper = latestCanvasMap.get(canvasTitle);
            const isLatest = targetKeeper && targetKeeper.turnIndex === currentTurnIndex;
            const linkText = isLatest ? 'Canvas 全文詳下' : 'Canvas 最新版詳下';
            if (canvasTitle) {
                return `\n\n[[#${canvasTitle}|${linkText}]]\n\n`;
            }
            return `\n\n[[#Canvas|${linkText}]]\n\n`;
        }

        if (node.classList.contains('inline-preview-container') ||
            node.classList.contains('table-footer') ||
            node.classList.contains('cdk-visually-hidden') ||
            node.classList.contains('screen-reader-user-query-label') ||
            node.classList.contains('screen-reader-model-response-label') ||
            (tag === 'h5' && /^(你說了|You said)/i.test(node.textContent.trim()))) {
            return '';
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
        const allRows = Array.from(tableElement.querySelectorAll('tr'));
        if (allRows.length === 0) return '';

        const getCellMarkdown = (cell) => {
            let cellMd = '';
            cell.childNodes.forEach(child => {
                cellMd += parseNode(child);
            });
            return cellMd.trim().replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|');
        };

        let markdown = '\n\n';
        const theadRows = tableElement.querySelectorAll('thead tr');
        let headerRow = null;
        let bodyRows = [];

        if (theadRows.length > 0) {
            headerRow = theadRows[0];
            bodyRows = Array.from(tableElement.querySelectorAll('tbody tr'));
        } else {
            headerRow = allRows[0];
            bodyRows = allRows.slice(1);
        }

        const headerCells = Array.from(headerRow.querySelectorAll('th, td')).map(getCellMarkdown);
        if (headerCells.length === 0) return '';

        markdown += `| ${headerCells.join(' | ')} |\n`;
        markdown += `| ${headerCells.map(() => '---').join(' | ')} |\n`;

        bodyRows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('th, td')).map(getCellMarkdown);
            while (cells.length < headerCells.length) {
                cells.push('');
            }
            markdown += `| ${cells.join(' | ')} |\n`;
        });

        return markdown + '\n';
    }

    function demoteHeadings(text, targetMinLevel = 3) {
        if (!text || typeof text !== 'string') return text;

        // Split by code blocks (``` or ~~~) to protect code comments from being modified
        const codeBlockRegex = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
        const parts = text.split(codeBlockRegex);

        // First pass: find the minimum heading level among non-code parts
        let minLevel = 7;
        for (let i = 0; i < parts.length; i += 2) {
            const matches = parts[i].match(/^(#{1,6})\s+/gm);
            if (matches) {
                for (const m of matches) {
                    const level = m.trim().length;
                    if (level < minLevel) {
                        minLevel = level;
                    }
                }
            }
        }

        // If no headings found, or minimum level is already >= targetMinLevel (3)
        if (minLevel >= 7 || minLevel >= targetMinLevel) {
            return text;
        }

        const shift = targetMinLevel - minLevel;

        // Second pass: shift headings in non-code parts
        for (let i = 0; i < parts.length; i += 2) {
            parts[i] = parts[i].replace(/^(#{1,6})(\s+.*)$/gm, (match, hashes, rest) => {
                const newLevel = Math.min(6, hashes.length + shift);
                return '#'.repeat(newLevel) + rest;
            });
        }

        return parts.join('');
    }

    function wrapInlineHtmlInCode(text) {
        if (!text || typeof text !== 'string') return text;

        // 1. Split text by code blocks (fenced ``` or ~~~) and existing inline code (`...`)
        const codeBlockRegex = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;
        const parts = text.split(codeBlockRegex);

        // 2. Regex for inline HTML tags or comments (exclude autolinks like <http...> or <user@...>)
        const inlineHtmlRegex = /(<(?!\/?[a-zA-Z]+:\/\/|[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)(\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^>]*?)?\/?>|<!--[\s\S]*?-->)/g;

        for (let i = 0; i < parts.length; i += 2) {
            parts[i] = parts[i].replace(inlineHtmlRegex, '`$1`');
        }

        return parts.join('');
    }

    function extractContent() {
        const isSharePage = window.location.pathname.startsWith('/share/') || window.location.pathname.includes('DOM.html') || decodeURIComponent(window.location.pathname).includes('分享');
        const title = cleanTitle(getTitle());
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
            const titleElement = document.querySelector('h1 strong, h1');
            if (titleElement) {
                markdown += `# ${cleanTitle(titleElement.textContent)}\n\n`;
            } else {
                markdown += `# ${title}\n\n`;
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

        // Helper to extract canvas info from a turn
        function getCanvasesFromTurn(turn) {
            const results = [];

            // 1. Legacy container (.immersive-artifact-container)
            const legacyContainers = turn.querySelectorAll('.immersive-artifact-container');
            legacyContainers.forEach(container => {
                const titleEl = container.querySelector('h2.title-text, h2');
                const contentEl = container.querySelector('.immersive-artifact-content');
                if (titleEl) {
                    const title = titleEl.textContent.trim();
                    results.push({
                        title: title,
                        contentEl: contentEl || null,
                        hasFullContent: !!(contentEl && contentEl.textContent.trim())
                    });
                }
            });
            if (results.length > 0) return results;

            // 2. Modern inline-preview
            let previews = turn.querySelectorAll('inline-preview');
            if (previews.length === 0) {
                previews = turn.querySelectorAll('.inline-preview-container');
            }
            previews.forEach(preview => {
                const titleEl = preview.querySelector('.card-title, .title, h2');
                const contentEl = preview.querySelector('.ProseMirror, .immersive-editor, #extended-response-markdown-content');
                const title = titleEl ? titleEl.textContent.trim() : '';
                if (title) {
                    const editorEl = contentEl ? (contentEl.querySelector('.ProseMirror') || contentEl) : null;
                    results.push({
                        title: title,
                        contentEl: editorEl,
                        hasFullContent: !!(editorEl && editorEl.textContent.trim())
                    });
                }
            });

            // 3. Modern processing cards (e.g. gem-processing-card, immersive-entry-chip without inline-preview)
            let procCards = turn.querySelectorAll('gem-processing-card');
            if (procCards.length === 0) {
                procCards = turn.querySelectorAll('immersive-entry-chip');
            }
            procCards.forEach(card => {
                if (card.closest('inline-preview, .inline-preview-container')) return;
                if (card.querySelector('inline-preview, .inline-preview-container')) return;

                const titleEl = card.querySelector('.card-title, .title, h2');
                if (titleEl) {
                    const title = titleEl.textContent.trim();
                    if (title && !results.some(r => r.title === title)) {
                        results.push({
                            title: title,
                            contentEl: null,
                            hasFullContent: false
                        });
                    }
                }
            });

            return results;
        }

        // Pre-process canvas entries across turns to identify duplicates
        const canvasEntries = [];
        turns.forEach((turn, turnIndex) => {
            const canvases = getCanvasesFromTurn(turn);
            canvases.forEach((canvas, canvasIndex) => {
                let head = '';
                let tail = '';
                if (canvas.hasFullContent && canvas.contentEl) {
                    const text = canvas.contentEl.textContent.trim();
                    const N = 50;
                    head = text.substring(0, N);
                    tail = text.substring(Math.max(0, text.length - N));
                }
                canvasEntries.push({
                    turnIndex,
                    canvasIndex,
                    title: canvas.title,
                    hasFullContent: canvas.hasFullContent,
                    head,
                    tail,
                    contentEl: canvas.contentEl,
                    isDuplicate: false
                });
            });
        });

        // Group by title to pick the latest/best occurrence for the appendix
        const titleGroups = new Map();
        canvasEntries.forEach(entry => {
            if (!titleGroups.has(entry.title)) {
                titleGroups.set(entry.title, []);
            }
            titleGroups.get(entry.title).push(entry);
        });

        latestCanvasMap.clear();
        titleGroups.forEach((groupEntries, title) => {
            let targetKeeper = null;
            for (let i = groupEntries.length - 1; i >= 0; i--) {
                if (groupEntries[i].hasFullContent) {
                    targetKeeper = groupEntries[i];
                    break;
                }
            }
            if (!targetKeeper) {
                targetKeeper = groupEntries[groupEntries.length - 1];
            }
            if (targetKeeper) {
                latestCanvasMap.set(title, targetKeeper);
            }
        });

        turns.forEach((turn, index) => {
            currentTurnIndex = index;
            const userQuery = turn.querySelector('user-query');
            if (userQuery) {
                userCount++;
                const userText = parseNode(userQuery).trim();
                markdown += `## User ${userCount}\n${demoteHeadings(userText)}\n\n`;
            }

            const modelResponse = turn.querySelector('.model-response-text') || turn.querySelector('.message-content');
            if (modelResponse) {
                geminiCount++;
                markdown += `## Gemini ${geminiCount}\n`;
                let responseText = '';
                modelResponse.childNodes.forEach(node => {
                    responseText += parseNode(node);
                });
                markdown += demoteHeadings(responseText.trim()) + '\n\n';
            }
        });

        currentTurnIndex = -1;

        // Append all unique latest Canvas documents at the very bottom
        titleGroups.forEach((groupEntries) => {
            let targetKeeper = null;
            for (let i = groupEntries.length - 1; i >= 0; i--) {
                if (groupEntries[i].hasFullContent) {
                    targetKeeper = groupEntries[i];
                    break;
                }
            }
            if (!targetKeeper) {
                targetKeeper = groupEntries[groupEntries.length - 1];
            }

            if (targetKeeper) {
                markdown += `---\n\n## ${targetKeeper.title}\n\n`;
                if (targetKeeper.hasFullContent && targetKeeper.contentEl) {
                    let canvasText = '';
                    targetKeeper.contentEl.childNodes.forEach(node => {
                        canvasText += parseNode(node);
                    });
                    markdown += demoteHeadings(canvasText.trim()) + '\n\n';
                } else {
                    markdown += `（此 Canvas 於對話中未展開）\n\n`;
                }
            }
        });

        const formattedMarkdown = wrapInlineHtmlInCode(markdown);

        return formattedMarkdown
            .replace(/(?<!`)`\./g, '`\u3000.')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
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