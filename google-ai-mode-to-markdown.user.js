// ==UserScript==
// @name         Google AI Mode to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.1.0
// @description  Converts a Google Search AI Mode (udm=50) conversation into a Markdown file.
// @author       Aiuanyu
// @match        https://www.google.com/search*
// @match        https://www.google.com.tw/search*
// @grant        none
// @license      MIT
// @history      0.1.0 2026-11-26 - Initial release supporting Google Search AI Mode (udm=50) multi-turn conversations, tables, nested lists, inline citation links, and Obsidian-compatible Markdown.
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.1.0';
    const BUTTON_ID = 'google-ai-mode-md-export-btn';

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

    function isAiModePage() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('udm') === '50') return true;
        return !!(document.querySelector('[data-aim="1"]') && document.querySelector('.CKgc1d .mZJni'));
    }

    function addStyles() {
        if (document.getElementById('google-ai-mode-md-style')) return;
        const css = `
            #${BUTTON_ID} {
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
            #${BUTTON_ID}:hover {
                background-color: #185abc;
                box-shadow: 0 6px 16px rgba(0,0,0,0.3);
            }
            #${BUTTON_ID}:disabled {
                background-color: #5f6368;
                cursor: wait;
                opacity: 0.92;
            }
        `;
        const styleSheet = document.createElement('style');
        styleSheet.id = 'google-ai-mode-md-style';
        styleSheet.textContent = css;
        document.head.appendChild(styleSheet);
    }

    function createButton() {
        if (document.getElementById(BUTTON_ID)) return;
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.textContent = 'MD';
        button.title = '匯出 Google AI 模式對話為 Markdown';
        button.onclick = () => handleExport(button);
        document.body.appendChild(button);
    }

    function cleanTitle(rawTitle) {
        if (!rawTitle || typeof rawTitle !== 'string') return '';
        return rawTitle
            .replace(/\s*[-|]\s*Google\s*(?:搜尋|Search).*$/i, '')
            .trim();
    }

    function sanitizeFilename(title) {
        const cleaned = cleanTitle(title);
        return (cleaned || 'google-ai-mode').replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    function getTitle() {
        const aimEl = document.querySelector('[data-aim="1"]');
        const dataQ = aimEl ? aimEl.getAttribute('data-q') : '';
        if (dataQ && dataQ.trim()) {
            return cleanTitle(dataQ.trim());
        }

        const params = new URLSearchParams(window.location.search);
        const queryParam = params.get('q');
        if (queryParam && queryParam.trim()) {
            return cleanTitle(queryParam.trim());
        }

        if (document.title) {
            const cleaned = cleanTitle(document.title);
            if (cleaned) return cleaned;
        }

        return 'google-ai-mode';
    }

    function isHiddenElement(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
        const styleAttr = (node.getAttribute('style') || '').toLowerCase();
        if (/display\s*:\s*none/.test(styleAttr)) return true;
        if (node.hidden) return true;
        try {
            const computed = window.getComputedStyle(node);
            if (computed && computed.display === 'none') return true;
        } catch (e) {}
        return false;
    }

    function shouldSkipElement(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
        const tag = node.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'svg', 'button', 'textarea', 'input', 'select'].includes(tag)) {
            return true;
        }
        if (isHiddenElement(node)) return true;

        const skipClasses = [
            'bNg8Rb',   // Screen reader heading ("搜尋結果", "AI 模式對話")
            'MheKwc',   // Screen reader turn heading
            'iMqumd',   // Screen reader follow-up heading
            'alk4p',    // Bottom feedback/spacer container
            'Eonz0',    // Feedback thank-you message
            'XpWxo',    // Feedback legal disclaimer
            'QRnEfb',   // Google privacy/terms notice
            'dfyMHf',   // "瞭解詳情" AI Overview link
            'SGF5Lb',   // "AI 摘要" badge header
            'DBd2Wb',   // Citation "+N" overflow pill container
            'zkL70c',   // Citation "+N" overflow pill
            'KmyaV',    // Citation "+N" count wrapper
            'OkUHJe'    // Inline "+1" count badge
        ];
        for (const cls of skipClasses) {
            if (node.classList.contains(cls)) return true;
        }

        if (node.hasAttribute('data-zzy')) return true;
        return false;
    }

    function parseCitationBadge(node) {
        const links = Array.from(node.querySelectorAll('a[href]')).filter(a => {
            const href = a.getAttribute('href') || '';
            return href && !href.startsWith('#') && !href.startsWith('javascript:');
        });
        if (links.length === 0) return '';

        const formatted = [];
        const seen = new Set();
        links.forEach(a => {
            const href = a.href;
            if (!href || seen.has(href)) return;
            seen.add(href);
            const label = (a.getAttribute('aria-label') || a.textContent || '來源').trim();
            formatted.push(`[${label}](${href})`);
        });
        return formatted.length > 0 ? ` (${formatted.join(', ')})` : '';
    }

    function collectDirectListItems(listNode) {
        const items = [];
        Array.from(listNode.children).forEach(child => {
            const childTag = child.tagName.toLowerCase();
            if (childTag === 'li') {
                items.push(child);
            } else if (childTag === 'div') {
                // Google AI Mode wraps <li> elements inside <div> containers inside <ul>/<ol>
                Array.from(child.children).forEach(grandChild => {
                    if (grandChild.tagName.toLowerCase() === 'li') {
                        items.push(grandChild);
                    }
                });
            }
        });
        return items;
    }

    function parseList(listNode, listLevel = 0) {
        const isOrdered = listNode.tagName.toLowerCase() === 'ol';
        const indent = '    '.repeat(listLevel);
        const items = collectDirectListItems(listNode);
        if (items.length === 0) return '';

        let listContent = '';
        items.forEach((li, i) => {
            const marker = isOrdered ? `${i + 1}.` : '-';
            let liText = '';
            let nestedList = '';
            li.childNodes.forEach(liChild => {
                if (liChild.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(liChild.tagName.toLowerCase())) {
                    nestedList += parseList(liChild, listLevel + 1);
                } else {
                    liText += parseNode(liChild, listLevel);
                }
            });
            liText = liText.replace(/^\s*\n|\n\s*$/g, '').trim();
            if (liText || nestedList) {
                listContent += `\n${indent}${marker} ${liText}${nestedList}`;
            }
        });
        return listContent ? `\n${listContent}\n` : '';
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

    function parseNode(node, listLevel = 0) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        if (shouldSkipElement(node)) {
            return '';
        }

        // Inline citation badge (e.g., "GitHub +1" chip)
        if (node.classList.contains('Wg1cdb')) {
            return parseCitationBadge(node);
        }

        const tag = node.tagName.toLowerCase();

        if (tag === 'ul' || tag === 'ol') {
            return parseList(node, listLevel);
        }

        if (tag === 'table') {
            return parseTable(node);
        }

        if (tag === 'pre') {
            const codeEl = node.querySelector('code');
            const codeText = codeEl ? codeEl.textContent : node.textContent;
            let lang = '';
            if (codeEl && codeEl.className) {
                const match = codeEl.className.match(/(?:language-|lang-)(\w+)/);
                if (match) lang = match[1];
            }
            return `\n\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n\n`;
        }

        // Google AI Mode section headings inside response
        if (node.classList.contains('ZLzG0d') || (tag === 'div' && node.getAttribute('role') === 'heading')) {
            let headingText = '';
            node.childNodes.forEach(child => {
                headingText += parseNode(child, listLevel);
            });
            headingText = headingText.trim();
            return headingText ? `\n\n### ${headingText}\n\n` : '';
        }

        // Google AI Mode paragraph containers
        if (node.classList.contains('n6owBd')) {
            let paraText = '';
            node.childNodes.forEach(child => {
                paraText += parseNode(child, listLevel);
            });
            paraText = paraText.trim();
            return paraText ? `\n\n${paraText}\n\n` : '';
        }

        let childMarkdown = '';
        node.childNodes.forEach(child => {
            childMarkdown += parseNode(child, listLevel);
        });

        switch (tag) {
            case 'p':
                return childMarkdown.trim() ? `\n\n${childMarkdown.trim()}\n\n` : '';
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
                return childMarkdown.trim() ? `**${childMarkdown.trim()}**` : '';
            case 'i':
            case 'em':
                return childMarkdown.trim() ? `*${childMarkdown.trim()}*` : '';
            case 'del':
            case 's':
            case 'strike':
                return childMarkdown.trim() ? `~~${childMarkdown.trim()}~~` : '';
            case 'blockquote': {
                if (!childMarkdown.trim()) return '';
                const quoteLines = childMarkdown.trim().split('\n').map(line => line.trim() ? `> ${line}` : '>');
                return `\n\n${quoteLines.join('\n')}\n\n`;
            }
            case 'hr':
                return '\n\n---\n\n';
            case 'br':
                return '\n';
            case 'code':
                return node.closest('pre') ? childMarkdown : `\`${childMarkdown}\``;
            case 'a': {
                const href = node.getAttribute('href') || '';
                if (!href || href.startsWith('javascript:')) return childMarkdown;
                const text = childMarkdown.trim() || (node.getAttribute('aria-label') || '').trim() || node.href;
                return `[${text}](${node.href})`;
            }
            default:
                return childMarkdown;
        }
    }

    function demoteHeadings(text, targetMinLevel = 3) {
        if (!text || typeof text !== 'string') return text;

        const codeBlockRegex = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
        const parts = text.split(codeBlockRegex);

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

        if (minLevel >= 7 || minLevel >= targetMinLevel) {
            return text;
        }

        const shift = targetMinLevel - minLevel;
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

        const codeBlockRegex = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;
        const parts = text.split(codeBlockRegex);
        const inlineHtmlRegex = /(<(?!\/?[a-zA-Z]+:\/\/|[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^>]*?)?\/?>|<!--[\s\S]*?-->)/g;

        for (let i = 0; i < parts.length; i += 2) {
            parts[i] = parts[i].replace(inlineHtmlRegex, '`$1`');
        }

        return parts.join('');
    }

    function normalizeSpacing(text) {
        return text
            .replace(/\u00a0/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function extractPromptFromHeading(turnContainer) {
        const h3 = turnContainer.querySelector('h3.MheKwc, h3.iMqumd');
        if (!h3) return '';
        const text = (h3.textContent || '').trim();
        const match = text.match(/^AI\s*模式針對「([\s\S]+?)」的回覆$/);
        if (match && match[1]) return match[1].trim();
        const enMatch = text.match(/^AI\s*Mode\s*response\s*for\s*["“]([\s\S]+?)["”]$/i);
        return enMatch && enMatch[1] ? enMatch[1].trim() : '';
    }

    function collectTurns() {
        const responseContainers = Array.from(document.querySelectorAll('.CKgc1d')).filter(el => el.querySelector('.mZJni'));
        if (responseContainers.length === 0) return [];

        const aimEl = document.querySelector('[data-aim="1"]');
        const followUpPrompts = aimEl ? Array.from(aimEl.querySelectorAll('.VndcI')) : [];
        let followUpIndex = 0;

        return responseContainers.map((container, idx) => {
            let userPrompt = '';
            if (idx === 0) {
                userPrompt = getTitle();
            } else {
                // Find the closest preceding .VndcI element in document order
                while (followUpIndex < followUpPrompts.length) {
                    const candidate = followUpPrompts[followUpIndex];
                    const rel = candidate.compareDocumentPosition(container);
                    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) {
                        userPrompt = (candidate.textContent || '').trim();
                        followUpIndex++;
                    } else {
                        break;
                    }
                }
            }

            if (!userPrompt) {
                userPrompt = extractPromptFromHeading(container);
            }

            const responseEl = container.querySelector('.mZJni');
            let responseMd = '';
            if (responseEl) {
                responseEl.childNodes.forEach(child => {
                    responseMd += parseNode(child);
                });
            }

            return {
                userPrompt: normalizeSpacing(userPrompt),
                responseMd: wrapInlineHtmlInCode(demoteHeadings(normalizeSpacing(responseMd)))
            };
        });
    }

    function extractContent() {
        const title = getTitle();
        const escapedTitle = title.replace(/"/g, '\\"');
        const exportedAt = formatUtc8Timestamp(new Date());

        const turns = collectTurns();
        if (turns.length === 0) {
            return 'Error: Could not find Google AI Mode conversation content.';
        }

        let markdown = `---
parser: "Google AI Mode to Markdown v${SCRIPT_VERSION}"
title: "${escapedTitle}"
url: "${window.location.href}"
exported_at: "${exportedAt}"
tags:
  - Google-AI-Mode
---

# ${title}

`;

        turns.forEach((turn, idx) => {
            const turnNum = idx + 1;
            if (turn.userPrompt) {
                markdown += `## 👤 User ${turnNum}\n\n${wrapInlineHtmlInCode(turn.userPrompt)}\n\n`;
            }
            if (turn.responseMd) {
                markdown += `## 🤖 Google AI Mode ${turnNum}\n\n${turn.responseMd}\n\n`;
            }
        });

        return markdown.trim() + '\n';
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

    function handleExport(button) {
        if (isExporting) return;
        isExporting = true;
        button.disabled = true;

        try {
            button.textContent = '✓ 下載中...';
            downloadMarkdown();
            button.textContent = '✓ 完成';
            setTimeout(() => {
                button.textContent = 'MD';
                button.disabled = false;
                isExporting = false;
            }, 1800);
        } catch (err) {
            console.error('Google AI Mode to Markdown export error:', err);
            button.textContent = '⚠️ 失敗';
            setTimeout(() => {
                button.textContent = 'MD';
                button.disabled = false;
                isExporting = false;
            }, 2000);
        }
    }

    function tryInit() {
        if (isAiModePage() && document.querySelector('.CKgc1d .mZJni')) {
            addStyles();
            createButton();
            return true;
        }
        return false;
    }

    if (!tryInit()) {
        const observer = new MutationObserver(() => {
            if (tryInit()) {
                // Keep observing in case Google Search dynamically switches tabs/DOM
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }
})();
