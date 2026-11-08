// ==UserScript==
// @name         ChatGPT to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.4.0
// @description  Converts a ChatGPT conversation into a Markdown file.
// @author       Aiuanyu
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @license      MIT
// @history      0.4.0 2026-11-08 - Added support for ChatGPT share URLs (/share/UUID) via backend API; grouped multi-step assistant turns (thoughts, code, text) into unified turns; added progressive DOM auto-scroll collector to prevent virtual scrolling data loss; added backtick-dot Obsidian formatting protection.
// @history      0.3.0 2026-10-16 - Supported new ChatGPT DOM structure (search-unit-keys and MarkdownRoot); added adaptive heading demotion (demoteHeadings); improved file attachment extraction for resource cards.
// @history      0.2.0 2026-09-23 - Added support for file attachments in both API (msg.metadata.attachments) and DOM (file tile and aria-label).
// @history      0.1.0 2026-09-21 - Initial release: supports ChatGPT conversation extraction (API-first with DOM fallback), image attachments, code blocks, tables, and sidebar title matching.
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.4.0';

    function addStyles() {
        if (document.getElementById('chatgpt-to-md-styles')) return;
        const css = `
            .download-markdown-button {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background-color: #10a37f;
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
                background-color: #0e8c6d;
            }
            .download-markdown-button:active {
                transform: scale(0.95);
            }
        `;
        const styleSheet = document.createElement("style");
        styleSheet.id = 'chatgpt-to-md-styles';
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

    function getConversationInfo() {
        const path = window.location.pathname;
        const shareMatch = path.match(/\/share\/([0-9a-f-]{36})/i);
        if (shareMatch) {
            return { id: shareMatch[1], isShare: true };
        }
        const chatMatch = path.match(/\/c\/([0-9a-f-]{36})/i);
        if (chatMatch) {
            return { id: chatMatch[1], isShare: false };
        }
        return null;
    }

    function getChatId() {
        const info = getConversationInfo();
        return info ? info.id : null;
    }

    function cleanTitle(rawTitle) {
        if (!rawTitle || typeof rawTitle !== 'string') return '';
        return rawTitle
            .replace(/\s*[-|]\s*ChatGPT.*$/i, '')
            .replace(/^ChatGPT\s*[-|]\s*/i, '')
            .trim();
    }

    function getTitle() {
        const convInfo = getConversationInfo();

        // 1. Sidebar link matching current chat UUID
        if (convInfo && !convInfo.isShare) {
            const sidebarLink = document.querySelector(`a[href*="${convInfo.id}"]`);
            if (sidebarLink) {
                const label = sidebarLink.getAttribute('aria-label');
                if (label && label.trim()) return cleanTitle(label);

                const truncateEl = sidebarLink.querySelector('.truncate');
                if (truncateEl && truncateEl.textContent.trim()) {
                    return cleanTitle(truncateEl.textContent);
                }

                const clone = sidebarLink.cloneNode(true);
                clone.querySelectorAll('svg, button').forEach(el => el.remove());
                const text = clone.textContent.trim();
                if (text) return cleanTitle(text);
            }
        }

        // 2. Active sidebar link
        const activeLink = document.querySelector('[data-sidebar-item="true"][data-active="true"], a.bg-token-sidebar-surface-secondary');
        if (activeLink) {
            const label = activeLink.getAttribute('aria-label');
            if (label && label.trim()) return cleanTitle(label);
            const text = activeLink.textContent.trim();
            if (text) return cleanTitle(text);
        }

        // 3. Document title (clean up "- ChatGPT", "| ChatGPT")
        if (document.title) {
            const cleaned = cleanTitle(document.title);
            if (cleaned && !/^chatgpt$/i.test(cleaned)) {
                return cleaned;
            }
        }

        // 4. Fallback: First user message first line
        const firstUserMsg = document.querySelector('div[data-chatgpt-search-unit-key$=":user"], div[data-content-search-unit-key$=":user"], [data-message-author-role="user"]');
        if (firstUserMsg) {
            const firstLine = firstUserMsg.textContent.trim().split('\n')[0].substring(0, 50).trim();
            if (firstLine) return cleanTitle(firstLine);
        }

        return 'chatgpt-chat';
    }

    function sanitizeFilename(title) {
        const cleaned = cleanTitle(title);
        return (cleaned || 'chatgpt-chat').replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    async function fetchConversationFromAPI(convInfo) {
        if (!convInfo) return null;
        try {
            let accessToken = null;
            try {
                const sessionRes = await fetch(window.location.origin + '/api/auth/session', { credentials: 'include' });
                if (sessionRes.ok) {
                    const sessionData = await sessionRes.json();
                    accessToken = sessionData.accessToken;
                }
            } catch (e) {
                console.warn("[ChatGPT to Markdown] Failed to fetch auth session:", e);
            }

            const headers = { 'credentials': 'include' };
            if (accessToken) {
                headers['Authorization'] = `Bearer ${accessToken}`;
            }

            const endpoint = convInfo.isShare
                ? `/backend-api/share/${convInfo.id}`
                : `/backend-api/conversation/${convInfo.id}`;

            const convRes = await fetch(window.location.origin + endpoint, {
                credentials: 'include',
                headers: headers
            });

            if (convRes.ok) {
                return await convRes.json();
            }
        } catch (e) {
            console.warn("[ChatGPT to Markdown] API fetch failed:", e);
        }
        return null;
    }

    function formatAPIConversation(data) {
        const title = (data.title && data.title.trim()) ? data.title.trim() : getTitle();
        const escapedTitle = title.replace(/"/g, '\\"');

        let markdown = `---
parser: "ChatGPT to Markdown v${SCRIPT_VERSION}"
title: "${escapedTitle}"
url: "${window.location.href}"
tags:
  - ChatGPT
---

# ${title}

`;

        // Traverse mapping from current_node backwards to build chronological chain
        const mapping = data.mapping || {};
        const chain = [];
        let currId = data.current_node;

        while (currId && mapping[currId]) {
            const node = mapping[currId];
            if (node.message && node.message.content && node.message.author) {
                const role = node.message.author.role;
                if (role === 'user' || role === 'assistant' || role === 'tool') {
                    chain.unshift(node.message);
                }
            }
            currId = node.parent;
        }

        // If linear chain wasn't reconstructed, fall back to linear_conversation or mapping values
        let messages = chain;
        if (messages.length === 0 && Array.isArray(data.linear_conversation)) {
            messages = data.linear_conversation.map(n => n.message).filter(Boolean);
        }
        if (messages.length === 0) {
            messages = Object.values(mapping)
                .map(n => n.message)
                .filter(m => m && (m.author?.role === 'user' || m.author?.role === 'assistant'))
                .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
        }

        // Group multi-step assistant actions into unified conversational turns
        let userCount = 0;
        let assistantCount = 0;
        let pendingAssistant = [];

        function flushAssistant() {
            if (pendingAssistant.length === 0) return;
            let fullBody = '';
            let thoughts = '';
            const attachments = [];

            pendingAssistant.forEach(msg => {
                if (msg.metadata && Array.isArray(msg.metadata.attachments)) {
                    msg.metadata.attachments.forEach(att => {
                        const name = att.name || att.file_name || att.title;
                        if (name && !attachments.includes(name)) attachments.push(name);
                    });
                }

                const content = msg.content;
                if (!content) return;

                if (content.content_type === 'thoughts') {
                    const text = content.text || (Array.isArray(content.parts) ? content.parts.join('\n') : '');
                    if (text && text.trim()) {
                        thoughts += text.trim() + '\n\n';
                    }
                } else if (content.content_type === 'code') {
                    const code = content.text || (Array.isArray(content.parts) ? content.parts.join('\n') : '');
                    if (code && code.trim()) {
                        if (code.trim().startsWith('```')) {
                            fullBody += `${code.trim()}\n\n`;
                        } else {
                            fullBody += `\`\`\`python\n${code.trim()}\n\`\`\`\n\n`;
                        }
                    }
                } else if (content.content_type === 'text' && Array.isArray(content.parts)) {
                    fullBody += content.parts.filter(p => typeof p === 'string' && p.trim()).join('\n\n') + '\n\n';
                } else if (content.text) {
                    fullBody += content.text.trim() + '\n\n';
                } else if (Array.isArray(content.parts)) {
                    content.parts.forEach(part => {
                        if (typeof part === 'string' && part.trim()) {
                            fullBody += part.trim() + '\n\n';
                        } else if (part && typeof part === 'object') {
                            if (part.content_type === 'image_asset_pointer') {
                                fullBody += `![image](${part.asset_pointer})\n\n`;
                            }
                        }
                    });
                }
            });

            let finalBody = '';
            if (attachments.length > 0) {
                finalBody += `> **Attachments:** ${attachments.map(a => `\`${a}\``).join(', ')}\n\n`;
            }
            if (thoughts.trim()) {
                finalBody += `<details><summary>Thinking Process</summary>\n\n${thoughts.trim()}\n\n</details>\n\n`;
            }
            if (fullBody.trim()) {
                finalBody += fullBody.trim() + '\n\n';
            }

            if (finalBody.trim()) {
                assistantCount++;
                markdown += `## ChatGPT ${assistantCount}\n\n${demoteHeadings(finalBody.trim())}\n\n`;
            }
            pendingAssistant = [];
        }

        messages.forEach(msg => {
            const role = msg.author?.role;
            if (role === 'user') {
                flushAssistant();
                userCount++;
                let userBody = '';

                // Attachments
                const attachments = [];
                if (msg.metadata && Array.isArray(msg.metadata.attachments)) {
                    msg.metadata.attachments.forEach(att => {
                        const name = att.name || att.file_name || att.title;
                        if (name && !attachments.includes(name)) attachments.push(name);
                    });
                }
                if (attachments.length > 0) {
                    userBody += `> **Attachments:** ${attachments.map(a => `\`${a}\``).join(', ')}\n\n`;
                }

                const content = msg.content;
                if (content) {
                    if (Array.isArray(content.parts)) {
                        content.parts.forEach(part => {
                            if (typeof part === 'string') {
                                userBody += part + '\n\n';
                            } else if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer') {
                                userBody += `![image](${part.asset_pointer})\n\n`;
                            }
                        });
                    } else if (content.text) {
                        userBody += content.text + '\n\n';
                    }
                }
                markdown += `## User ${userCount}\n\n${demoteHeadings(userBody.trim())}\n\n`;
            } else if (role === 'assistant') {
                pendingAssistant.push(msg);
            }
        });

        flushAssistant();

        return {
            title,
            content: markdown
                .replace(/(?<!`)`\./g, '`\u3000.')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
        };
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

        if (node.classList && (node.classList.contains('sr-only') || node.classList.contains('select-none'))) {
            return '';
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

    function parseUserTurn(turnNode) {
        let result = '';

        // Extract any user file attachments (role group, file tile, or modern resource card)
        const fileTiles = turnNode.querySelectorAll('[role="group"][aria-label], [class*="group/file-tile"], [class*="group/resource-card"]');
        const attachments = [];
        fileTiles.forEach(tile => {
            let fileName = tile.getAttribute('aria-label');
            if (!fileName) {
                const btn = tile.querySelector('button[aria-label]');
                if (btn) fileName = btn.getAttribute('aria-label');
            }
            if (!fileName) {
                const titleSpan = tile.querySelector('[title]');
                if (titleSpan) fileName = titleSpan.getAttribute('title');
            }
            if (!fileName) {
                const labelEl = tile.querySelector('.truncate.font-semibold, .font-semibold');
                if (labelEl) fileName = labelEl.textContent.trim();
            }
            if (fileName && fileName.length < 150 && !attachments.includes(fileName)) {
                attachments.push(fileName);
            }
        });
        if (attachments.length > 0) {
            result += `> **Attachments:** ${attachments.map(a => `\`${a}\``).join(', ')}\n\n`;
        }

        // Extract any user images
        const images = turnNode.querySelectorAll('img');
        images.forEach(img => {
            const src = img.getAttribute('src');
            const alt = img.getAttribute('alt') || 'uploaded-image';
            if (src && !src.startsWith('data:image/svg')) {
                result += `![${alt}](${src})\n\n`;
            }
        });

        const bubble = turnNode.querySelector('.whitespace-pre-wrap') ||
                       turnNode.querySelector('[data-user-message-bubble="true"]') ||
                       turnNode.querySelector('[data-testid="collapsible-user-message-content"]') ||
                       turnNode;
        const text = parseNode(bubble).trim();
        if (text) {
            result += text;
        }

        return demoteHeadings(result.trim());
    }

    function parseAssistantTurn(turnNode) {
        let result = '';

        // Extract reasoning/thinking if present
        const thoughtBox = turnNode.querySelector('[data-testid="thought-box"], .thought, [aria-label*="Thinking"], [aria-label*="思考"]');
        if (thoughtBox) {
            const thoughtText = parseNode(thoughtBox).trim();
            if (thoughtText) {
                result += `<details><summary>Thinking Process</summary>\n\n${thoughtText}\n\n</details>\n\n`;
            }
        }

        const contentContainer = turnNode.querySelector('[data-markdown-text-style="assistant-message"]') ||
                                 turnNode.querySelector('.markdown, [class*="MarkdownRoot"]') ||
                                 turnNode;
        const mainText = parseNode(contentContainer).trim();
        if (mainText) {
            result += mainText;
        }

        return demoteHeadings(result.trim());
    }

    async function extractContentFromDOM() {
        const title = cleanTitle(getTitle());
        const escapedTitle = title.replace(/"/g, '\\"');

        let markdown = `---
parser: "ChatGPT to Markdown v${SCRIPT_VERSION}"
title: "${escapedTitle}"
url: "${window.location.href}"
tags:
  - ChatGPT
---

# ${title}

`;

        // Progressive auto-scroll collector to prevent virtual scrolling data loss
        const scroller = document.querySelector('.thread-scroll-container, [class*="thread-scroll-container"]') ||
                         document.querySelector('main div.overflow-y-auto') ||
                         document.querySelector('div.overflow-y-auto');

        if (scroller && scroller.scrollHeight > scroller.clientHeight + 300) {
            const originalScrollTop = scroller.scrollTop;
            const collectedUnits = new Map();

            const collect = () => {
                const searchUnits = document.querySelectorAll('div[data-chatgpt-search-unit-key], div[data-content-search-unit-key]');
                searchUnits.forEach(el => {
                    const key = el.getAttribute('data-chatgpt-search-unit-key') || el.getAttribute('data-content-search-unit-key');
                    if (key && !collectedUnits.has(key)) {
                        collectedUnits.set(key, el.cloneNode(true));
                    }
                });
            };

            scroller.scrollTop = 0;
            await new Promise(r => setTimeout(r, 200));
            collect();

            const step = Math.max(300, Math.floor(scroller.clientHeight * 0.75));
            let curr = 0;
            while (curr < scroller.scrollHeight) {
                curr += step;
                scroller.scrollTop = curr;
                await new Promise(r => setTimeout(r, 150));
                collect();
            }
            scroller.scrollTop = originalScrollTop;

            if (collectedUnits.size > 0) {
                const userTurns = [];
                const asstTurns = [];
                collectedUnits.forEach((el, key) => {
                    if (key.endsWith(':user')) userTurns.push(el);
                    else if (key.endsWith(':assistant')) asstTurns.push(el);
                });

                const getTurnIndex = el => {
                    const k = el.getAttribute('data-chatgpt-search-unit-key') || el.getAttribute('data-content-search-unit-key') || '';
                    const m = k.match(/turn-(\d+)/);
                    return m ? parseInt(m[1], 10) : 0;
                };

                const allTurns = [];
                userTurns.forEach(el => allTurns.push({ role: 'user', el, idx: getTurnIndex(el) }));
                asstTurns.forEach(el => allTurns.push({ role: 'assistant', el, idx: getTurnIndex(el) }));

                allTurns.sort((a, b) => {
                    if (a.idx !== b.idx) return a.idx - b.idx;
                    return a.role === 'user' ? -1 : 1;
                });

                let userCount = 0;
                let assistantCount = 0;
                allTurns.forEach(({ role, el }) => {
                    if (role === 'user') {
                        userCount++;
                        markdown += `## User ${userCount}\n\n${parseUserTurn(el)}\n\n`;
                    } else {
                        assistantCount++;
                        markdown += `## ChatGPT ${assistantCount}\n\n${parseAssistantTurn(el)}\n\n`;
                    }
                });

                return markdown
                    .replace(/(?<!`)`\./g, '`\u3000.')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
            }
        }

        // 1. Try modern ChatGPT search unit key selectors
        let userTurns = Array.from(document.querySelectorAll('div[data-chatgpt-search-unit-key$=":user"], div[data-content-search-unit-key$=":user"]'));
        userTurns = userTurns.filter(el => !el.parentElement.closest('div[data-chatgpt-search-unit-key$=":user"], div[data-content-search-unit-key$=":user"]'));

        let asstTurns = Array.from(document.querySelectorAll('div[data-chatgpt-search-unit-key$=":assistant"], div[data-content-search-unit-key$=":assistant"]'));
        asstTurns = asstTurns.filter(el => !el.parentElement.closest('div[data-chatgpt-search-unit-key$=":assistant"], div[data-content-search-unit-key$=":assistant"]'));

        if (userTurns.length > 0 || asstTurns.length > 0) {
            const allTurns = [];
            userTurns.forEach(el => allTurns.push({ role: 'user', el }));
            asstTurns.forEach(el => allTurns.push({ role: 'assistant', el }));
            allTurns.sort((a, b) => {
                const pos = a.el.compareDocumentPosition(b.el);
                return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
            });

            let userCount = 0;
            let assistantCount = 0;

            allTurns.forEach(({ role, el }) => {
                if (role === 'user') {
                    userCount++;
                    markdown += `## User ${userCount}\n\n${parseUserTurn(el)}\n\n`;
                } else {
                    assistantCount++;
                    markdown += `## ChatGPT ${assistantCount}\n\n${parseAssistantTurn(el)}\n\n`;
                }
            });

            return markdown
                .replace(/(?<!`)`\./g, '`\u3000.')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }

        // 2. Fallback to legacy selectors
        const allElements = Array.from(document.querySelectorAll(`
            [data-message-author-role="user"], 
            [data-message-author-role="assistant"]
        `));

        let userCount = 0;
        let assistantCount = 0;

        allElements.forEach(el => {
            const role = el.getAttribute('data-message-author-role');
            if (role === 'user') {
                userCount++;
                markdown += `## User ${userCount}\n\n${parseUserTurn(el)}\n\n`;
            } else {
                assistantCount++;
                markdown += `## ChatGPT ${assistantCount}\n\n${parseAssistantTurn(el)}\n\n`;
            }
        });

        if (userCount === 0 && assistantCount === 0) {
            console.error("[ChatGPT to Markdown] Chat content not found.");
            return "Error: Could not find chat content.";
        }

        return markdown
            .replace(/(?<!`)`\./g, '`\u3000.')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    async function downloadMarkdown() {
        const button = document.querySelector('.download-markdown-button');
        const originalText = button ? button.innerText : 'MD';
        if (button) {
            button.innerText = '⏳';
            button.style.pointerEvents = 'none';
        }

        try {
            let title = cleanTitle(getTitle());
            let markdownContent = '';

            const convInfo = getConversationInfo();
            if (convInfo) {
                const apiData = await fetchConversationFromAPI(convInfo);
                if (apiData && apiData.mapping) {
                    const parsed = formatAPIConversation(apiData);
                    title = cleanTitle(parsed.title);
                    markdownContent = parsed.content;
                }
            }

            // Fallback to DOM extraction
            if (!markdownContent) {
                markdownContent = await extractContentFromDOM();
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
            console.error("[ChatGPT to Markdown] Download failed:", err);
            alert("匯出 Markdown 失敗，請開啟 Console 檢視錯誤。");
        } finally {
            if (button) {
                button.innerText = originalText;
                button.style.pointerEvents = 'auto';
            }
        }
    }

    const observer = new MutationObserver(() => {
        const readySelector = '[data-message-author-role="user"], [data-message-author-role="assistant"], #prompt-textarea, [data-chatgpt-search-unit-key], [data-user-message-bubble]';
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
