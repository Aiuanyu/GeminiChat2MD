// ==UserScript==
// @name         Claude Code Web to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.2.0
// @description  Converts a Claude Code Web chat conversation into a Markdown file.
// @author       Aiuanyu
// @match        https://claude.ai/code/*
// @grant        none
// @license      MIT
// @history      0.2.0 2026-11-14 - Supported 2026 Claude Code Web DOM structure (transcript-row, user-message, assistant-message, TurnStatus); added demoteHeadings; fixed button mounting observer; added Obsidian backtick-dot formatting protection.
// @history      0.1 2025-11-29 - Initial release.
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.2.0';

    function addStyles() {
        if (document.getElementById('claude-code-web-to-md-styles')) return;
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
        styleSheet.id = 'claude-code-web-to-md-styles';
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

    function cleanTitle(rawTitle) {
        if (!rawTitle || typeof rawTitle !== 'string') return '';
        return rawTitle
            .replace(/\s*[-—|]\s*Claude.*$/i, '')
            .replace(/^[💬\s]+/, '')
            .trim();
    }

    function getTitle() {
        // 1. Session header heading
        const titleH2 = document.querySelector('h2.min-w-\\[32px\\], [class*="min-w-[32px]"] h2, h2');
        if (titleH2 && titleH2.textContent.trim()) {
            const text = cleanTitle(titleH2.textContent.trim());
            if (text && text !== '導覽') return text;
        }

        // 2. Document title
        if (document.title) {
            const cleaned = cleanTitle(document.title);
            if (cleaned && !/^claude$/i.test(cleaned)) return cleaned;
        }

        // 3. Fallback: First user message first line
        const firstUser = document.querySelector('[data-testid="user-message"]');
        if (firstUser) {
            const line = firstUser.textContent.trim().split('\n')[0].substring(0, 50).trim();
            if (line) return cleanTitle(line);
        }

        return 'claude-code-web';
    }

    function sanitizeFilename(title) {
        const cleaned = cleanTitle(title);
        return (cleaned || 'claude-code-web').replace(/[\\/:*?"<>|]/g, '_').trim();
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
                    if (level < minLevel) minLevel = level;
                }
            }
        }

        if (minLevel >= 7 || minLevel >= targetMinLevel) return text;

        const shift = targetMinLevel - minLevel;
        for (let i = 0; i < parts.length; i += 2) {
            parts[i] = parts[i].replace(/^(#{1,6})(\s+.*)$/gm, (match, hashes, rest) => {
                const newLevel = Math.min(6, hashes.length + shift);
                return '#'.repeat(newLevel) + rest;
            });
        }

        return parts.join('');
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
            const text = node.textContent;
            if (text.trim() === '[Request interrupted by user]') {
                return `> [!warn] Request interrupted by user`;
            }
            return text;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        if (node.classList && (node.classList.contains('sr-only') || node.classList.contains('select-none'))) {
            return '';
        }

        if (node.tagName.toLowerCase() === 'button' || node.tagName.toLowerCase() === 'svg') {
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
            return `\n\n<details><summary>${summaryText}</summary>\n\n\`\`\`\n${contentText.trim()}\n\`\`\`\n</details>\n\n`;
        }

        let childMarkdown = '';
        node.childNodes.forEach(child => {
            childMarkdown += parseNode(child, listLevel);
        });

        switch (node.tagName.toLowerCase()) {
            case 'p':
                return `\n\n${childMarkdown.trim()}`;
            case 'h1': return `\n\n# ${childMarkdown.trim()}\n\n`;
            case 'h2': return `\n\n## ${childMarkdown.trim()}\n\n`;
            case 'h3': return `\n\n### ${childMarkdown.trim()}\n\n`;
            case 'h4': return `\n\n#### ${childMarkdown.trim()}\n\n`;
            case 'h5': return `\n\n##### ${childMarkdown.trim()}\n\n`;
            case 'h6': return `\n\n###### ${childMarkdown.trim()}\n\n`;
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
            case 'blockquote': {
                if (!childMarkdown.trim()) return '';
                const quoteLines = childMarkdown.trim().split('\n').map(line => line.trim() ? `> ${line}` : '>');
                return `\n\n${quoteLines.join('\n')}\n\n`;
            }
            case 'hr': return '\n\n---\n\n';
            case 'br': return '\n';
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
            case 'li': return childMarkdown;
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
            case 'table': return parseTable(node);
            case 'a': return `[${childMarkdown}](${node.href})`;
            default: return childMarkdown;
        }
    }

    function extractContent() {
        const title = getTitle();

        let markdown = `---
parser: "Claude Code Web to Markdown v${SCRIPT_VERSION}"
title: "${title}"
url: "${window.location.href}"
tags:
  - Claude_Code_Web
---

# ${title}

`;

        let rows = Array.from(document.querySelectorAll('[data-testid="transcript-row"]'));
        if (rows.length === 0) {
            rows = Array.from(document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]'));
        }

        if (rows.length === 0) {
            console.error("[Claude Code Web to Markdown] Chat content not found.");
            return "Error: Could not find chat content.";
        }

        let userCount = 0;
        let claudeCount = 0;
        let pendingClaude = [];

        function flushClaude() {
            if (pendingClaude.length === 0) return;
            claudeCount++;
            const fullText = pendingClaude.join('\n\n').trim();
            markdown += `## Claude ${claudeCount}\n\n${demoteHeadings(fullText)}\n\n`;
            pendingClaude = [];
        }

        rows.forEach(r => {
            const userMsg = r.matches && r.matches('[data-testid="user-message"]') ? r : r.querySelector('[data-testid="user-message"]');
            const asstMsg = r.matches && r.matches('[data-testid="assistant-message"]') ? r : r.querySelector('[data-testid="assistant-message"]');

            if (userMsg) {
                flushClaude();
                userCount++;
                const userText = parseNode(userMsg).trim();
                markdown += `## User ${userCount}\n\n${demoteHeadings(userText)}\n\n`;
            } else if (asstMsg) {
                const turnStatus = asstMsg.querySelector('[data-cds="TurnStatus"]');
                if (turnStatus) {
                    const statusText = turnStatus.textContent.trim().replace(//g, '').trim();
                    if (statusText) {
                        pendingClaude.push(`> ⚙️ **${statusText}**`);
                    }
                } else {
                    const asstText = parseNode(asstMsg).trim();
                    if (asstText) {
                        pendingClaude.push(asstText);
                    }
                }
            }
        });

        flushClaude();

        return markdown
            .replace(/(?<!`)`\./g, '`\u3000.')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
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
            console.error("[Claude Code Web to Markdown] Download failed:", err);
            alert("匯出 Markdown 失敗，請開啟 Console 檢視錯誤。");
        } finally {
            if (button) {
                button.innerText = originalText;
                button.style.pointerEvents = 'auto';
            }
        }
    }

    const observer = new MutationObserver(() => {
        const readySelector = '[data-testid="user-message"], [data-testid="assistant-message"], [data-testid="transcript-row"], [data-testid="transcript-rows"], [data-cds="AssistantMessage"]';
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

    document.addEventListener('DOMContentLoaded', () => {
        addStyles();
        createButton();
    });

})();
