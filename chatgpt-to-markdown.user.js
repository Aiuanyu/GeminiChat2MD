// ==UserScript==
// @name         ChatGPT to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.1.0
// @description  Converts a ChatGPT conversation into a Markdown file.
// @author       Aiuanyu
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @license      MIT
// @history      0.1.0 2026-09-21 - Initial release: supports ChatGPT conversation extraction (API-first with DOM fallback), image attachments, code blocks, tables, and sidebar title matching.
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.1.0';

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

    function getChatId() {
        const match = window.location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
        return match ? match[1] : null;
    }

    function getTitle() {
        const chatId = getChatId();

        // 1. Sidebar link matching current chat UUID
        if (chatId) {
            const sidebarLink = document.querySelector(`a[href*="${chatId}"]`);
            if (sidebarLink) {
                const label = sidebarLink.getAttribute('aria-label');
                if (label && label.trim()) return label.trim();

                const truncateEl = sidebarLink.querySelector('.truncate');
                if (truncateEl && truncateEl.textContent.trim()) {
                    return truncateEl.textContent.trim();
                }

                const clone = sidebarLink.cloneNode(true);
                clone.querySelectorAll('svg, button').forEach(el => el.remove());
                const text = clone.textContent.trim();
                if (text) return text;
            }
        }

        // 2. Active sidebar link
        const activeLink = document.querySelector('[data-sidebar-item="true"][data-active="true"], a.bg-token-sidebar-surface-secondary');
        if (activeLink) {
            const label = activeLink.getAttribute('aria-label');
            if (label && label.trim()) return label.trim();
            const text = activeLink.textContent.trim();
            if (text) return text;
        }

        // 3. Document title (clean up "- ChatGPT", "| ChatGPT")
        if (document.title) {
            const cleaned = document.title
                .replace(/\s*[-|]\s*ChatGPT.*$/i, '')
                .replace(/^ChatGPT\s*[-|]\s*/i, '')
                .trim();
            if (cleaned && !/^chatgpt$/i.test(cleaned)) {
                return cleaned;
            }
        }

        // 4. Fallback: First user message first line
        const firstUserMsg = document.querySelector('[data-message-author-role="user"]');
        if (firstUserMsg) {
            const firstLine = firstUserMsg.textContent.trim().split('\n')[0].substring(0, 50).trim();
            if (firstLine) return firstLine;
        }

        return 'chatgpt-chat';
    }

    function sanitizeFilename(title) {
        return (title || 'chatgpt-chat').replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    async function fetchConversationFromAPI(chatId) {
        try {
            let accessToken = null;
            try {
                const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
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

            const convRes = await fetch(`/backend-api/conversation/${chatId}`, {
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
                if (role === 'user' || role === 'assistant') {
                    chain.unshift(node.message);
                }
            }
            currId = node.parent;
        }

        // If linear chain wasn't reconstructed, fall back to values of mapping
        const messages = chain.length > 0 ? chain : Object.values(mapping)
            .map(n => n.message)
            .filter(m => m && (m.author?.role === 'user' || m.author?.role === 'assistant'))
            .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));

        let userCount = 0;
        let assistantCount = 0;

        messages.forEach(msg => {
            const isUser = msg.author?.role === 'user';
            let body = '';

            const content = msg.content;
            if (content) {
                if (content.content_type === 'text' && Array.isArray(content.parts)) {
                    body += content.parts.join('\n\n').trim();
                } else if (content.text) {
                    body += content.text.trim();
                } else if (Array.isArray(content.parts)) {
                    content.parts.forEach(part => {
                        if (typeof part === 'string') {
                            body += part + '\n\n';
                        } else if (part && typeof part === 'object') {
                            if (part.content_type === 'image_asset_pointer') {
                                body += `![image](${part.asset_pointer})\n\n`;
                            }
                        }
                    });
                }
            }

            if (isUser) {
                userCount++;
                markdown += `## User ${userCount}\n\n${body.trim()}\n\n`;
            } else {
                assistantCount++;
                markdown += `## ChatGPT ${assistantCount}\n\n${body.trim()}\n\n`;
            }
        });

        return {
            title,
            content: markdown.replace(/\n{3,}/g, '\n\n').trim()
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

    function parseUserTurn(turnNode) {
        let result = '';

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
                       turnNode.querySelector('[data-testid="collapsible-user-message-content"]') ||
                       turnNode;
        const text = parseNode(bubble).trim();
        if (text) {
            result += text;
        }

        return result.trim();
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

        const contentContainer = turnNode.querySelector('.markdown') || turnNode;
        const mainText = parseNode(contentContainer).trim();
        if (mainText) {
            result += mainText;
        }

        return result.trim();
    }

    function extractContentFromDOM() {
        const title = getTitle();
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
                if (apiData && apiData.mapping) {
                    const parsed = formatAPIConversation(apiData);
                    title = parsed.title;
                    markdownContent = parsed.content;
                }
            }

            // Fallback to DOM extraction
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
        const readySelector = '[data-message-author-role="user"], [data-message-author-role="assistant"], #prompt-textarea';
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
