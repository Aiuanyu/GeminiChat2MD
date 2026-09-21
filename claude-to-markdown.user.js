// ==UserScript==
// @name         Claude to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.9.1
// @description  Converts a Claude chat conversation into a Markdown file.
// @author       Aiuanyu
// @match        https://claude.ai/chat/*
// @grant        none
// @license      MIT
// @history      0.9.1 2026-09-21 - Demoted message headings to start from H3 (###) to prevent outline collision with turn headings (## User / ## Claude).
// @history      0.9.0 2026-09-18 - Implemented API-first extraction to support complete conversation retrieval with virtual scrolling (Rocksteady) DOM fallback.
// @history      0.8.1 2026-07-22 - Switched to unified DOM selector for turns, bypassed data-test-render-count, fixed sr-only duplicate text.
// @history      0.8 2026-07-22 - Improved title extraction, fixed missing user messages/turns, and added support for tables, blockquotes, and attachments.
// @history      0.7 2025-11-17 - Added support for hyperlinks.
// @history      0.6 2025-11-17 - Added changelog and updated feature comparison table.
// @history      0.5 2025-11-17 - Added support for parsing "Artifact" blocks.
// @history      0.4 2025-11-17 - Fixed handling of multi-part responses.
// @history      0.3 2025-11-17 - Switched to a more reliable selector for the chat title and simplified the code.
// @history      0.2 2025-11-17 - Fixed content extraction to include headings and moved the button to the bottom-right.
// @history      0.1 2025-11-17 - Initial release.
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.9.1';

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
        if (document.querySelector('.download-markdown-button')) return;
        const button = document.createElement("button");
        button.innerText = "MD";
        button.title = "Download as Markdown";
        button.className = "download-markdown-button";
        button.onclick = downloadMarkdown;
        document.body.appendChild(button);
    }

    function parseTitleFromAriaLabel(label) {
        if (!label) return null;
        const match = label.match(/^(.*?)\s*,\s*(rename chat|chat options|options|edit title)$/i);
        if (match && match[1].trim()) {
            return match[1].trim();
        }
        return null;
    }

    function getTitle() {
        // 1. Try chat title button element (data-testid="chat-title-button")
        const titleButton = document.querySelector('[data-testid="chat-title-button"]');
        if (titleButton) {
            const labelTitle = parseTitleFromAriaLabel(titleButton.getAttribute('aria-label'));
            if (labelTitle) return labelTitle;

            const truncateEl = titleButton.querySelector('.truncate');
            if (truncateEl && truncateEl.textContent.trim()) {
                return truncateEl.textContent.trim();
            }

            const clone = titleButton.cloneNode(true);
            clone.querySelectorAll('svg').forEach(svg => svg.remove());
            const text = clone.textContent.trim();
            if (text) return text;
        }

        // 2. Search header / nav / main elements with aria-label matching title pattern
        const headerElements = document.querySelectorAll('header [aria-label], nav [aria-label], main [aria-label]');
        for (const el of headerElements) {
            const labelTitle = parseTitleFromAriaLabel(el.getAttribute('aria-label'));
            if (labelTitle) return labelTitle;
        }

        // 3. Search anywhere in DOM for elements with aria-label matching title pattern (e.g., "[title], rename chat")
        const allAriaElements = document.querySelectorAll('[aria-label*="rename chat"], [aria-label*="chat options"], [aria-label*="options"]');
        for (const el of allAriaElements) {
            const labelTitle = parseTitleFromAriaLabel(el.getAttribute('aria-label'));
            if (labelTitle) return labelTitle;
        }

        // 4. Try document.title (clean up " - Claude", " | Claude", "Claude")
        if (document.title) {
            const cleanedTitle = document.title
                .replace(/\s*[-|]\s*Claude.*$/i, '')
                .replace(/^Claude\s*[-|]\s*/i, '')
                .trim();
            if (cleanedTitle && !/^claude(\.ai)?$/i.test(cleanedTitle)) {
                return cleanedTitle;
            }
        }

        // 5. Fallback: First user message snippet
        const firstUserMsg = document.querySelector('[data-testid="user-message"], .font-user-message');
        if (firstUserMsg) {
            const firstLine = firstUserMsg.textContent.trim().split('\n')[0].substring(0, 50).trim();
            if (firstLine) return firstLine;
        }

        return 'claude-chat';
    }

    function sanitizeFilename(title) {
        return (title || 'claude-chat').replace(/[\\/:*?"<>|]/g, '_').trim();
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

        if (node.classList && node.classList.contains('sr-only')) {
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
                return '\n\n---\n\n';
            case 'br':
                return '\n';
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
            case 'code':
                return node.closest('pre') ? childMarkdown : `\`${childMarkdown}\``;
            case 'pre':
                const langElement = node.querySelector('.text-text-500.font-small, [class*="language-"]');
                let lang = langElement ? langElement.textContent.trim() : '';
                if (!lang) {
                    const codeEl = node.querySelector('code');
                    if (codeEl && codeEl.className) {
                        const match = codeEl.className.match(/language-(\w+)/);
                        if (match) lang = match[1];
                    }
                }
                const codeNode = node.querySelector('code');
                const codeText = codeNode ? codeNode.textContent : node.textContent;
                return `\n\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n\n`;
            case 'table':
                return parseTable(node);
            case 'a':
                return `[${childMarkdown}](${node.href})`;
            default:
                return childMarkdown;
        }
    }

    function parseArtifactBlock(node) {
        const titleElement = node.querySelector('.leading-tight.text-sm.line-clamp-1');
        const previewElement = node.querySelector('.whitespace-pre-wrap.text-\\[0\\.3rem\\]');

        let markdown = '\n\n';
        if (titleElement) {
            markdown += `> **_${titleElement.textContent.trim()}_**\n>\n`;
        }
        if (previewElement) {
            const previewText = previewElement.textContent.trim().replace(/\n/g, '\n> ');
            markdown += `> ${previewText}\n\n`;
        }
        return markdown;
    }

    function parseUserTurn(turnNode) {
        let result = '';

        // Extract attachment filenames if present
        const attachmentElements = turnNode.querySelectorAll('[aria-label*="attachment"], .bg-bg-300 .truncate, [data-testid="file-thumbnail"], .bg-bg-300');
        const attachments = [];
        attachmentElements.forEach(att => {
            if (att.querySelector('[data-testid="user-message"]')) return;
            const text = att.textContent.trim();
            if (text && text.length < 100 && !attachments.includes(text) && !att.querySelector('p')) {
                attachments.push(text);
            }
        });

        if (attachments.length > 0) {
            result += `> **Attachments:** ${attachments.map(a => `\`${a}\``).join(', ')}\n\n`;
        }

        const userMsg = turnNode.querySelector('[data-testid="user-message"], .font-user-message') || turnNode;
        const msgText = parseNode(userMsg).trim();
        if (msgText) {
            result += msgText;
        }

        return result.trim();
    }

    function parseClaudeTurn(turnNode) {
        let claudeText = '';
        const responseContainer = turnNode.classList.contains('font-claude-response') ? turnNode : turnNode.querySelector('.font-claude-response');
        const target = responseContainer || turnNode;

        if (target.children && target.children.length > 0) {
            Array.from(target.children).forEach(child => {
                if (child.querySelector('.artifact-block-cell') || child.classList.contains('artifact-block-cell')) {
                    claudeText += parseArtifactBlock(child).trim() + '\n\n';
                } else {
                    const parsed = parseNode(child).trim();
                    if (parsed) {
                        claudeText += parsed + '\n\n';
                    }
                }
            });
        } else {
            claudeText += parseNode(target).trim();
        }

        return claudeText.trim();
    }

    function getChatId() {
        const match = window.location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
        return match ? match[1] : null;
    }

    async function fetchConversationFromAPI(chatId) {
        let orgId = localStorage.getItem('lastActiveOrg');
        if (!orgId) {
            try {
                const orgRes = await fetch('/api/organizations', { credentials: 'include' });
                if (orgRes.ok) {
                    const orgs = await orgRes.json();
                    if (Array.isArray(orgs) && orgs.length > 0) {
                        orgId = orgs[0].uuid;
                    }
                }
            } catch (e) {
                console.warn("[Claude to Markdown] Failed to fetch organizations:", e);
            }
        }
        if (!orgId) return null;

        try {
            const convRes = await fetch(`/api/organizations/${orgId}/chat_conversations/${chatId}?tree=True`, { credentials: 'include' });
            if (convRes.ok) {
                return await convRes.json();
            }
        } catch (e) {
            console.warn("[Claude to Markdown] Failed to fetch conversation API:", e);
        }
        return null;
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

    function formatAPIConversation(data) {
        const title = (data.name && data.name.trim()) ? data.name.trim() : getTitle();
        const escapedTitle = title.replace(/"/g, '\\"');

        let markdown = `---
parser: "Claude to Markdown v${SCRIPT_VERSION}"
title: "${escapedTitle}"
url: "${window.location.href}"
tags:
  - Claude
---

# ${title}

`;

        let userCount = 0;
        let claudeCount = 0;

        const messages = Array.isArray(data.chat_messages) ? data.chat_messages : [];
        messages.forEach(msg => {
            const isUser = msg.sender === 'human';
            let body = '';

            // Handle attachments & uploaded files
            const files = Array.isArray(msg.attachments) ? msg.attachments : (Array.isArray(msg.files) ? msg.files : []);
            const fileNames = files.map(f => f.file_name || f.name).filter(Boolean);
            if (fileNames.length > 0) {
                body += `> **Attachments:** ${fileNames.map(f => `\`${f}\``).join(', ')}\n\n`;
            }

            // Handle content blocks or plain text
            if (Array.isArray(msg.content)) {
                msg.content.forEach(block => {
                    if (typeof block === 'string') {
                        body += block.trim() + '\n\n';
                    } else if (block && typeof block === 'object') {
                        if (block.type === 'text' && block.text) {
                            body += block.text.trim() + '\n\n';
                        } else if (block.type === 'thinking' && block.thinking) {
                            body += `<details><summary>Thinking Process</summary>\n\n${block.thinking.trim()}\n\n</details>\n\n`;
                        } else if (block.type === 'tool_use') {
                            const name = block.name || 'tool';
                            const input = block.input || {};
                            if (input.content) {
                                body += `\`\`\`${input.language || ''}\n${input.content.trim()}\n\`\`\`\n\n`;
                            } else {
                                body += `> **Tool (${name}):**\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n\n`;
                            }
                        }
                    }
                });
            } else if (typeof msg.content === 'string' && msg.content.trim()) {
                body += msg.content.trim() + '\n\n';
            } else if (typeof msg.text === 'string' && msg.text.trim()) {
                body += msg.text.trim() + '\n\n';
            }

            const cleanBody = demoteHeadings(body.trim());
            if (isUser) {
                userCount++;
                markdown += `## User ${userCount}\n\n${cleanBody}\n\n`;
            } else {
                claudeCount++;
                markdown += `## Claude ${claudeCount}\n\n${cleanBody}\n\n`;
            }
        });

        return {
            title,
            content: markdown.replace(/\n{3,}/g, '\n\n').trim()
        };
    }

    function extractContentFromDOM() {
        const title = getTitle();
        const escapedTitle = title.replace(/"/g, '\\"');

        let markdown = `---
parser: "Claude to Markdown v${SCRIPT_VERSION}"
title: "${escapedTitle}"
url: "${window.location.href}"
tags:
  - Claude
---

# ${title}

`;

        // Gather all turn containers or message nodes in DOM order
        const allElements = Array.from(document.querySelectorAll(`
            [data-testid="user-message"], 
            .font-user-message, 
            [data-user-message-bubble="true"], 
            .cds-user-message-body,
            .font-claude-response
        `));

        // Filter out elements that are inside other matched elements (keep only top-level ones)
        const topElements = allElements.filter((el, idx) => {
            return !allElements.some((other, oIdx) => oIdx !== idx && other.contains(el));
        });

        let userCount = 0;
        let claudeCount = 0;

        topElements.forEach(el => {
            const isClaude = el.matches('.font-claude-response') || el.closest('.font-claude-response');
            
            if (isClaude) {
                claudeCount++;
                const turnContent = demoteHeadings(parseClaudeTurn(el));
                markdown += `## Claude ${claudeCount}\n\n${turnContent}\n\n`;
            } else {
                userCount++;
                // Find the outermost container that represents this turn to parse attachments correctly
                const wrapper = el.closest('[data-test-render-count]') || el.closest('.group\\/message-row') || el.closest('.group') || el;
                const turnContent = demoteHeadings(parseUserTurn(wrapper));
                markdown += `## User ${userCount}\n\n${turnContent}\n\n`;
            }
        });

        if (userCount === 0 && claudeCount === 0) {
            console.error("Chat content not found.");
            return "Error: Could not find chat content.";
        }

        return markdown.replace(/\n{3,}/g, '\n\n').trim();
    }

    async function downloadMarkdown() {
        const button = document.querySelector('.download-markdown-button');
        const originalText = button ? button.innerText : 'MD';
        if (button) {
            button.innerText = '⏳';
            button.style.pointerEvents = 'none';
        }

        try {
            let title = getTitle();
            let markdownContent = '';

            const chatId = getChatId();
            if (chatId) {
                const apiData = await fetchConversationFromAPI(chatId);
                if (apiData && Array.isArray(apiData.chat_messages) && apiData.chat_messages.length > 0) {
                    const parsed = formatAPIConversation(apiData);
                    title = parsed.title;
                    markdownContent = parsed.content;
                }
            }

            // Fallback to DOM extraction if API data was not retrieved
            if (!markdownContent) {
                markdownContent = extractContentFromDOM();
            }

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
            console.error("[Claude to Markdown] Download failed:", err);
            alert("匯出 Markdown 失敗，請開啟 Console 檢視錯誤。");
        } finally {
            if (button) {
                button.innerText = originalText;
                button.style.pointerEvents = 'auto';
            }
        }
    }

    // Run the script
    const observer = new MutationObserver((mutations, obs) => {
        const readySelector = '[data-testid="user-message"], .font-user-message, .font-claude-response, [data-testid="transcript-sizer"], [role="feed"]';
        if (document.querySelector(readySelector)) {
            addStyles();
            createButton();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Check immediately on load
    window.addEventListener('load', () => {
        addStyles();
        createButton();
    });

})();
