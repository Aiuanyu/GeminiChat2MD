// ==UserScript==
// @name         Gemini to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.18.0
// @description  Converts a Gemini chat conversation into a Markdown file, including support for shared chats, Canvas, and Deep Research reports.
// @author       Aiuanyu
// @match        https://gemini.google.com/app/*
// @match        https://gemini.google.com/gem/*
// @match        https://gemini.google.com/share/*
// @grant        none
// @license      MIT
// @history      0.18.0 2026-11-28 - Supported Gemini Deep Research reports (deep-research-immersive-panel, auto-expanding unopened report chips, filtering citation UI noise, and appending deep-research-source-lists).
// @history      0.17.0 2026-11-27 - Automatically convert Obsidian note URLs (obsidian:// and file://.../Obsidian/<vault>/...) to [[wikilinks]] outside frontmatter and code blocks.
// @history      0.16.1 2026-11-25 - Applied wrapInlineHtmlInCode only to message and Canvas bodies so per-turn <sup> timestamps are not wrapped in backticks.
// @history      0.16.0 2026-11-25 - Added batchexecute (hNvQHb) metadata enrichment for per-turn UTC+8 timestamps, AI model metadata, and frontmatter created_at/updated_at/exported_at/model while preserving DOM and Canvas extraction.
// @history      0.15.2 2026-11-02 - Fixed regular expression syntax error (unterminated group) in wrapInlineHtmlInCode for GreasyFork webhook sync.
// @history      0.15.1 2026-11-02 - Supported blockquote (>) rendering in chat and Canvas; changed unordered list marker from * to - for Obsidian Markdown compatibility.
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

    const SCRIPT_VERSION = '0.18.0';
    let latestCanvasMap = new Map();
    let currentTurnIndex = -1;

    function formatUtc8Timestamp(input) {
        if (!input) return '';
        const date = input instanceof Date ? input : new Date(input);
        if (Number.isNaN(date.getTime())) {
            return typeof input === 'string' ? input.trim() : '';
        }
        const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const yyyy = utc8.getUTCFullYear();
        const mm = pad(utc8.getUTCMonth() + 1);
        const dd = pad(utc8.getUTCDate());
        const hh = pad(utc8.getUTCHours());
        const mi = pad(utc8.getUTCMinutes());
        const ss = pad(utc8.getUTCSeconds());
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} +08:00`;
    }

    function formatSupUtc8Timestamp(input) {
        if (!input) return '';
        const date = input instanceof Date ? input : new Date(input);
        if (Number.isNaN(date.getTime())) {
            return typeof input === 'string' ? input.trim() : '';
        }
        const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const yyyy = utc8.getUTCFullYear();
        const mm = pad(utc8.getUTCMonth() + 1);
        const dd = pad(utc8.getUTCDate());
        const h = utc8.getUTCHours();
        const mi = pad(utc8.getUTCMinutes());
        return `${yyyy}${mm}${dd} ${h}:${mi} +08:00`;
    }

    function parseGeminiTimestamp(tsField) {
        if (!tsField) return null;
        let seconds = null;
        let nanos = 0;
        if (Array.isArray(tsField) && typeof tsField[0] === 'number') {
            seconds = tsField[0];
            nanos = typeof tsField[1] === 'number' ? tsField[1] : 0;
        } else if (typeof tsField === 'number') {
            seconds = tsField > 1e12 ? tsField / 1000 : tsField;
        }
        if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
        const date = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function getChatIdFromPath() {
        const match = window.location.pathname.match(/\/(?:app|gem(?:\/[^\/]+)?)\/([a-zA-Z0-9_-]{8,})/);
        return match ? match[1] : null;
    }

    async function fetchConversationMetadata() {
        const chatId = getChatIdFromPath();
        if (!chatId) return null;

        const wiz = (typeof window.wrappedJSObject !== 'undefined' && window.wrappedJSObject && window.wrappedJSObject.WIZ_global_data)
            || window.WIZ_global_data;
        if (!wiz || !wiz.SNlM0e) return null;

        const snlm0e = wiz.SNlM0e;
        const bl = wiz.cfb2h || '';
        const fsid = wiz.FdrFJe || '';
        const convKey = chatId.startsWith('c_') ? chatId : `c_${chatId}`;

        const turnMetaMap = new Map();
        let earliestDate = null;
        let latestDate = null;
        let latestModel = '';
        let cursor = null;
        const seenCursors = new Set();

        try {
            for (let page = 0; page < 50; page++) {
                const rpcPayload = [convKey, 50, cursor, 1, [1], [4], null, 1];
                const fReq = JSON.stringify([[["hNvQHb", JSON.stringify(rpcPayload), null, "generic"]]]);
                const body = new URLSearchParams({
                    'f.req': fReq,
                    'at': snlm0e
                });

                const params = new URLSearchParams({
                    rpcids: 'hNvQHb',
                    'source-path': window.location.pathname,
                    hl: 'zh-TW',
                    _reqid: String(Math.floor(1000000 + Math.random() * 8999999)),
                    rt: 'c'
                });
                if (bl) params.set('bl', bl);
                if (fsid) params.set('f.sid', fsid);

                const url = `${window.location.origin}/_/BardChatUi/data/batchexecute?${params.toString()}`;
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body: body.toString(),
                    credentials: 'include'
                });
                if (!resp.ok) break;

                const text = await resp.text();
                let wrbData = null;
                for (const line of text.split('\n')) {
                    if (!line.includes('wrb.fr')) continue;
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed && parsed[0] && parsed[0][2]) {
                            wrbData = JSON.parse(parsed[0][2]);
                            break;
                        }
                    } catch (e) {}
                }

                const turns = Array.isArray(wrbData && wrbData[0]) ? wrbData[0] : [];
                if (turns.length === 0) break;

                for (const t of turns) {
                    const rawId = t && t[0] && t[0][1];
                    if (typeof rawId !== 'string' || !rawId) continue;
                    const normalizedId = rawId.replace(/^r_/, '');

                    const modelDisplay = (t[3] && typeof t[3][21] === 'string') ? t[3][21].trim() : '';
                    const modelId = (t[3] && typeof t[3][31] === 'string') ? t[3][31].trim() : '';
                    const timestampDate = parseGeminiTimestamp(t[4]);

                    if (!turnMetaMap.has(normalizedId)) {
                        turnMetaMap.set(normalizedId, {
                            modelDisplay,
                            modelId,
                            timestampDate
                        });
                    }

                    if (!latestModel && (modelDisplay || modelId)) {
                        latestModel = modelDisplay || modelId;
                    }
                    if (timestampDate) {
                        if (!earliestDate || timestampDate < earliestDate) earliestDate = timestampDate;
                        if (!latestDate || timestampDate > latestDate) latestDate = timestampDate;
                    }
                }

                const nextCursor = (wrbData && typeof wrbData[1] === 'string' && wrbData[1]) ? wrbData[1] : null;
                if (!nextCursor || seenCursors.has(nextCursor)) break;
                seenCursors.add(nextCursor);
                cursor = nextCursor;
            }
        } catch (err) {
            console.warn('[Gemini to Markdown] Failed to fetch conversation metadata via batchexecute:', err);
        }

        return {
            turnMetaMap,
            createdAt: earliestDate,
            updatedAt: latestDate,
            sessionModel: latestModel
        };
    }

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
            tag === 'source-footnote' ||
            tag === 'sources-carousel-inline' ||
            tag === 'sources-carousel' ||
            tag === 'immersive-content-actions' ||
            tag === 'deep-research-source-lists' ||
            tag === 'thinking-panel' ||
            tag === 'thinking-panel-skeleton-loader' ||
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
            case 'del':
            case 's':
            case 'strike':
                return `~~${childMarkdown}~~`;
            case 'blockquote': {
                if (!childMarkdown.trim()) return '';
                const quoteLines = childMarkdown.trim().split('\n').map(line => line.trim() ? `> ${line}` : '>');
                return `\n\n${quoteLines.join('\n')}\n\n`;
            }
            case 'ul':
            case 'ol':
                let listContent = '';
                const indent = '    '.repeat(listLevel);
                Array.from(node.children).forEach((li, i) => {
                    const marker = node.tagName.toLowerCase() === 'ul' ? '-' : `${i + 1}.`;
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
            case 'br':
                return '\n';
            case 'code':
                return node.closest('pre') ? childMarkdown : `\`${childMarkdown}\``;
            case 'pre': {
                const codeEl = node.querySelector('code');
                const codeText = codeEl ? codeEl.textContent : node.textContent;
                let lang = '';
                if (codeEl && codeEl.className) {
                    const match = codeEl.className.match(/(?:language-|lang-)(\w+)/);
                    if (match) lang = match[1];
                }
                return `\n\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n\n`;
            }
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
        const inlineHtmlRegex = /(<(?!\/?[a-zA-Z]+:\/\/|[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^>]*?)?\/?>|<!--[\s\S]*?-->)/g;

        for (let i = 0; i < parts.length; i += 2) {
            parts[i] = parts[i].replace(inlineHtmlRegex, '`$1`');
        }

        return parts.join('');
    }

    function getDeepResearchPanelTitle(panel) {
        if (!panel) return '';
        const titleEl = panel.querySelector('.toolbar .left-panel, .toolbar .title, .title-text, h1, h2');
        if (!titleEl) return '';
        const clone = titleEl.cloneNode(true);
        clone.querySelectorAll('mat-icon, gem-icon, button').forEach(el => el.remove());
        return clone.textContent.trim();
    }

    function extractDeepResearchSources(panel) {
        if (!panel) return '';
        const sourceList = panel.querySelector('deep-research-source-lists');
        if (!sourceList) return '';

        const seenUrls = new Set();
        const items = [];
        sourceList.querySelectorAll('a[href]').forEach(a => {
            const href = a.href;
            if (!href || !/^https?:\/\//i.test(href) || seenUrls.has(href)) return;
            seenUrls.add(href);

            const subTitleEl = a.querySelector('.sub-title');
            const domainEl = a.querySelector('.display-name');
            const domain = domainEl ? domainEl.textContent.trim() : '';

            let label = subTitleEl ? subTitleEl.textContent.trim() : '';
            if (!label) {
                const clone = a.cloneNode(true);
                clone.querySelectorAll('.display-name, .cdk-visually-hidden, img').forEach(el => el.remove());
                label = clone.textContent.trim().replace(/\s+/g, ' ');
            }
            if (!label) label = domain || href;

            const safeLabel = label.replace(/[\[\]\r\n]+/g, ' ').trim();
            const domainNote = (domain && !safeLabel.includes(domain)) ? `（${domain}）` : '';
            items.push(`${items.length + 1}. [${safeLabel}](${href})${domainNote}`);
        });

        if (items.length === 0) return '';
        return `### 資料來源\n\n${items.join('\n')}`;
    }

    function extractOpenPanelSnapshot() {
        const panel = document.querySelector('deep-research-immersive-panel, immersive-panel');
        if (!panel) return null;

        const contentEl = panel.querySelector('#extended-response-message-content, #extended-response-markdown-content, .ProseMirror, .immersive-editor');
        if (!contentEl || !contentEl.textContent.trim()) return null;

        const title = getDeepResearchPanelTitle(panel);
        let bodyRaw = '';
        contentEl.childNodes.forEach(node => {
            bodyRaw += parseNode(node);
        });
        const bodyMd = wrapInlineHtmlInCode(demoteHeadings(bodyRaw.trim()));
        const sourcesMd = extractDeepResearchSources(panel);
        const markdown = sourcesMd ? `${bodyMd}\n\n${sourcesMd}` : bodyMd;

        return {
            title,
            markdown,
            signature: contentEl.textContent.trim().slice(0, 80) + ':' + contentEl.textContent.trim().length
        };
    }

    async function collectDeepResearchPanels(button) {
        const panelCache = new Map();
        const initialSnap = extractOpenPanelSnapshot();
        if (initialSnap && initialSnap.title && initialSnap.markdown) {
            panelCache.set(initialSnap.title, initialSnap);
        }

        const cards = Array.from(document.querySelectorAll('.conversation-container immersive-entry-chip, .conversation-container gem-processing-card'));
        for (const card of cards) {
            if (card.closest('inline-preview, .inline-preview-container')) continue;
            if (card.querySelector('inline-preview, .inline-preview-container')) continue;
            if (card.tagName.toLowerCase() === 'gem-processing-card' && card.closest('immersive-entry-chip')) continue;

            const titleEl = card.querySelector('.card-title, .title, h2');
            const cardTitle = titleEl ? titleEl.textContent.trim() : '';
            if (!cardTitle || panelCache.has(cardTitle)) continue;

            const prevSnap = extractOpenPanelSnapshot();
            const prevSig = prevSnap ? prevSnap.signature : '';

            const clickTarget = card.querySelector('gem-processing-card, button, [role="button"]') || card;
            if (typeof clickTarget.click !== 'function') continue;

            if (button) {
                button.innerText = '⏳ 載入報告...';
            }
            clickTarget.click();

            for (let attempt = 0; attempt < 15; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 200));
                const snap = extractOpenPanelSnapshot();
                if (snap && snap.markdown && (snap.title === cardTitle || snap.signature !== prevSig)) {
                    const key = snap.title || cardTitle;
                    panelCache.set(key, snap);
                    if (cardTitle && !panelCache.has(cardTitle)) {
                        panelCache.set(cardTitle, snap);
                    }
                    break;
                }
            }
        }

        return panelCache;
    }

    function extractContent(metaResult = null, panelCache = null) {
        const isSharePage = window.location.pathname.startsWith('/share/') || window.location.pathname.includes('DOM.html') || decodeURIComponent(window.location.pathname).includes('分享');
        const title = cleanTitle(getTitle());
        const escapedTitle = title.replace(/"/g, '\\"');
        const turnMetaMap = (metaResult && metaResult.turnMetaMap) ? metaResult.turnMetaMap : new Map();
        const sessionModel = (metaResult && metaResult.sessionModel) ? metaResult.sessionModel : '';
        const createdAt = (metaResult && metaResult.createdAt) ? formatUtc8Timestamp(metaResult.createdAt) : '';
        const updatedAt = (metaResult && metaResult.updatedAt) ? formatUtc8Timestamp(metaResult.updatedAt) : '';
        const exportedAt = formatUtc8Timestamp(new Date());

        let markdown = `---
parser: "Gemini to Markdown v${SCRIPT_VERSION}"
title: "${escapedTitle}"
url: "${window.location.href}"
`;
        if (sessionModel) {
            markdown += `model: "${sessionModel.replace(/"/g, '\\"')}"\n`;
        }
        if (createdAt) {
            markdown += `created_at: "${createdAt}"\n`;
        }
        if (updatedAt) {
            markdown += `updated_at: "${updatedAt}"\n`;
        }
        markdown += `exported_at: "${exportedAt}"
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
                        const cached = panelCache && panelCache.get(title);
                        results.push({
                            title: title,
                            contentEl: null,
                            cachedMarkdown: cached ? cached.markdown : '',
                            hasFullContent: !!(cached && cached.markdown)
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
                    cachedMarkdown: canvas.cachedMarkdown || '',
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
            const turnId = turn.id ? turn.id.replace(/^r_/, '') : '';
            const turnMeta = turnId ? turnMetaMap.get(turnId) : null;
            const supText = (turnMeta && turnMeta.timestampDate) ? formatSupUtc8Timestamp(turnMeta.timestampDate) : '';
            const supLine = supText ? `\n<sup>${supText}</sup>` : '';

            const userQuery = turn.querySelector('user-query');
            if (userQuery) {
                userCount++;
                const userText = wrapInlineHtmlInCode(demoteHeadings(parseNode(userQuery).trim()));
                markdown += `## 👤 User ${userCount}${supLine}\n\n${userText}\n\n`;
            }

            const modelResponse = turn.querySelector('.model-response-text') || turn.querySelector('.message-content');
            if (modelResponse) {
                geminiCount++;
                const modelLabel = turnMeta ? (turnMeta.modelDisplay || turnMeta.modelId || '') : '';
                const modelMeta = modelLabel ? ` (${modelLabel})` : '';
                markdown += `## 🤖 Gemini ${geminiCount}${modelMeta}${supLine}\n\n`;
                let responseText = '';
                modelResponse.childNodes.forEach(node => {
                    responseText += parseNode(node);
                });
                markdown += wrapInlineHtmlInCode(demoteHeadings(responseText.trim())) + '\n\n';
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
                if (targetKeeper.cachedMarkdown) {
                    markdown += targetKeeper.cachedMarkdown + '\n\n';
                } else if (targetKeeper.hasFullContent && targetKeeper.contentEl) {
                    let canvasText = '';
                    targetKeeper.contentEl.childNodes.forEach(node => {
                        canvasText += parseNode(node);
                    });
                    markdown += wrapInlineHtmlInCode(demoteHeadings(canvasText.trim())) + '\n\n';
                } else {
                    markdown += `（此 Canvas 於對話中未展開）\n\n`;
                }
            }
        });

        // Fallback: append any cached Deep Research panels not matched by turn chips
        if (panelCache && panelCache.size > 0) {
            panelCache.forEach((snap, key) => {
                if (!titleGroups.has(key) && (!snap.title || !titleGroups.has(snap.title)) && snap.markdown) {
                    const heading = snap.title || key || 'Deep Research 報告';
                    markdown += `---\n\n## ${heading}\n\n${snap.markdown}\n\n`;
                }
            });
        }

        const finalized = markdown
            .replace(/(?<!`)`\./g, '`\u3000.')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        return convertObsidianLinks(finalized);
    }

    function obsUrlToWikilink(rawUrl, label = null) {
        if (!rawUrl || (!rawUrl.startsWith('file://') && !rawUrl.startsWith('obsidian://'))) {
            return null;
        }

        let rel = '';
        let frag = '';

        if (rawUrl.startsWith('file://')) {
            let parsed;
            try {
                parsed = new URL(rawUrl);
            } catch {
                return null;
            }
            if (parsed.hostname && parsed.hostname !== 'localhost') return null;
            let decodedPath;
            try {
                decodedPath = decodeURIComponent(parsed.pathname || '');
            } catch {
                return null;
            }
            if (!decodedPath || decodedPath.endsWith('/')) return null;
            const vaultMatch = decodedPath.match(/\/obsidian\/[^/]+\/(.+)$/i);
            if (!vaultMatch) return null;
            rel = vaultMatch[1].replace(/^\/+/, '');
            if (!rel || rel.startsWith('.obsidian/')) return null;
            if (parsed.hash && parsed.hash.length > 1) {
                try {
                    frag = decodeURIComponent(parsed.hash.slice(1));
                } catch {
                    frag = parsed.hash.slice(1);
                }
            }
        } else {
            const rest = rawUrl.slice('obsidian://'.length);
            const hashIdx = rest.indexOf('#');
            const beforeHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
            const rawFrag = hashIdx >= 0 ? rest.slice(hashIdx + 1) : '';
            const qIdx = beforeHash.indexOf('?');
            if (qIdx < 0) return null;
            const action = beforeHash.slice(0, qIdx).replace(/^\/+|\/+$/g, '').toLowerCase();
            if (action !== 'open' && action !== 'adv-uri') return null;
            const params = new URLSearchParams(beforeHash.slice(qIdx + 1));
            const fileParam = params.get('file') || params.get('filepath') || '';
            rel = fileParam.replace(/^\/+|\/+$/g, '');
            if (!rel || rel.startsWith('.obsidian/')) return null;
            if (rawFrag) {
                try {
                    frag = decodeURIComponent(rawFrag);
                } catch {
                    frag = rawFrag;
                }
            }
        }

        const target = rel.toLowerCase().endsWith('.md') ? rel.slice(0, -3) : rel;
        const fragPart = (frag && !/^L\d+(?:-L?\d+)?$/.test(frag)) ? `#${frag}` : '';
        if (label === null) return `[[${target}${fragPart}]]`;

        const cleanLabel = label.trim();
        if (!cleanLabel) return `[[${target}${fragPart}]]`;

        const fileName = rel.split('/').pop() || rel;
        const dotIdx = fileName.lastIndexOf('.');
        const stem = (dotIdx > 0 && fileName.toLowerCase().endsWith('.md')) ? fileName.slice(0, dotIdx) : fileName;
        if (cleanLabel === fileName || cleanLabel === stem || cleanLabel === rel || cleanLabel === target) {
            return `[[${target}${fragPart}]]`;
        }
        return `[[${target}${fragPart}|${cleanLabel}]]`;
    }

    function convertObsidianLinksInParagraph(para) {
        if (!para.includes('file://') && !para.includes('obsidian://')) return para;
        const scanRe = /\\[^\n]|(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)|\[([^\[\]\n]*)\]\((?:<([^>\n]+)>|((?:[^()\s\n]|\([^()\s\n]*\))+))\)|<((?:file|obsidian):\/\/[^\s<>]+)>|((?:file|obsidian):\/\/[^\s<>\[\]()]+)/g;
        const trailingPunctRe = /[.,;:!?。，、；：）」』】]+$/;
        return para.replace(scanRe, (full, codeTicks, _codeBody, mdLabel, angleLink, plainLink, autoUrl, bareUrl) => {
            if (codeTicks !== undefined) return full;
            if (mdLabel !== undefined) {
                const url = angleLink !== undefined ? angleLink : plainLink;
                const converted = obsUrlToWikilink(url, mdLabel);
                return converted !== null ? converted : full;
            }
            if (autoUrl !== undefined) {
                const converted = obsUrlToWikilink(autoUrl);
                return converted !== null ? converted : full;
            }
            if (bareUrl !== undefined) {
                const punctMatch = bareUrl.match(trailingPunctRe);
                const suffix = punctMatch ? punctMatch[0] : '';
                const stripped = suffix ? bareUrl.slice(0, -suffix.length) : bareUrl;
                const converted = obsUrlToWikilink(stripped);
                return converted !== null ? (converted + suffix) : full;
            }
            return full;
        });
    }

    function convertObsidianLinks(markdown) {
        if (!markdown || (!markdown.includes('file://') && !markdown.includes('obsidian://'))) {
            return markdown;
        }
        let prefix = '';
        let body = markdown;
        const fmMatch = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        if (fmMatch) {
            prefix = fmMatch[0];
            body = markdown.slice(prefix.length);
        }

        const lines = body.split(/(\r?\n)/);
        const out = [];
        let plainBuf = [];
        let fenceChar = '';
        let fenceLen = 0;

        const flushPlain = () => {
            if (plainBuf.length === 0) return;
            const chunk = plainBuf.join('');
            plainBuf = [];
            const parts = chunk.split(/(\n[ \t]*\n)/);
            for (let i = 0; i < parts.length; i++) {
                out.push(i % 2 === 0 && parts[i] ? convertObsidianLinksInParagraph(parts[i]) : parts[i]);
            }
        };

        for (let i = 0; i < lines.length; i += 2) {
            const lineBody = lines[i];
            const nl = lines[i + 1] || '';
            const fullLine = lineBody + nl;
            if (fenceChar) {
                out.push(fullLine);
                const stripped = lineBody.replace(/^[ \t]+/, '');
                const indent = lineBody.length - stripped.length;
                const trimmed = stripped.replace(/[ \t]+$/, '');
                if (indent <= 3 && trimmed.length >= fenceLen && [...trimmed].every(c => c === fenceChar)) {
                    fenceChar = '';
                    fenceLen = 0;
                }
                continue;
            }
            const fenceMatch = lineBody.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
            if (fenceMatch) {
                const fence = fenceMatch[1];
                const info = fenceMatch[2];
                if (!(fence[0] === '`' && info.includes('`'))) {
                    flushPlain();
                    fenceChar = fence[0];
                    fenceLen = fence.length;
                    out.push(fullLine);
                    continue;
                }
            }
            plainBuf.push(fullLine);
        }
        flushPlain();
        return prefix + out.join('');
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

    function downloadMarkdown(metaResult = null, panelCache = null) {
        const title = getTitle();
        const markdownContent = extractContent(metaResult, panelCache);
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
            let metaResult = null;
            let panelCache = null;
            if (!isSharePage) {
                await autoScrollToTop(button);
                button.innerText = '⏳ 讀取資訊...';
                metaResult = await fetchConversationMetadata();
                panelCache = await collectDeepResearchPanels(button);
            }
            button.innerText = '✓ 下載中...';
            downloadMarkdown(metaResult, panelCache);
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