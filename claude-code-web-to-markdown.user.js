// ==UserScript==
// @name         Claude Code Web to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.4.1
// @description  Converts a Claude Code Web chat conversation into a Markdown file.
// @author       Aiuanyu
// @match        https://claude.ai/code/*
// @grant        none
// @license      MIT
// @history      0.4.1 2026-11-22 - Ignored <synthetic> model tag in assistant headings to prevent Obsidian Live Preview breakage, and formatted synthetic system notices as warning blockquotes.
// @history      0.4.0 2026-11-21 - Fixed 50-page (5000-event) truncation limit; isolated subagent events via parent_tool_use_id with tool-use stats; parsed <agent-message> and <task-notification> into collapsible details/blockquotes instead of fake User turns.
// @history      0.3.1 2026-11-16 - Aligned h2 turn format (👤/🤖 emojis, <sup>YYYYMMDD H:MM +08:00</sup> timestamp line) and 💭 Thinking block across Claude, Claude Code, and AgyChat2MD.
// @history      0.3.0 2026-11-15 - Added API-first extraction (/v1/code/sessions/{id}/events) with per-turn UTC+8 timestamps, AI model metadata, paginated event retrieval, and DOM fallback.
// @history      0.2.0 2026-11-14 - Supported 2026 Claude Code Web DOM structure (transcript-row, user-message, assistant-message, TurnStatus); added demoteHeadings; fixed button mounting observer; added Obsidian backtick-dot formatting protection.
// @history      0.1 2025-11-29 - Initial release.
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.4.1';

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

    function getSessionId() {
        const match = window.location.pathname.match(/\/code\/(session_[A-Za-z0-9_-]+)/i);
        return match ? match[1] : null;
    }

    async function fetchCodeSessionFromAPI(sessionId) {
        let orgId = localStorage.getItem('lastActiveOrg');
        if (!orgId) {
            try {
                const orgRes = await fetch(`${window.location.origin}/api/organizations`, { credentials: 'include' });
                if (orgRes.ok) {
                    const orgs = await orgRes.json();
                    if (Array.isArray(orgs) && orgs.length > 0) {
                        orgId = orgs[0].uuid;
                    }
                }
            } catch (e) {
                console.warn("[Claude Code Web to Markdown] Failed to fetch organizations:", e);
            }
        }
        if (!orgId) return null;

        const headers = {
            'anthropic-version': '2023-06-01',
            'x-organization-uuid': orgId
        };

        try {
            const sessionRes = await fetch(`${window.location.origin}/v1/code/sessions/${sessionId}`, {
                credentials: 'include',
                headers
            });
            const sessionData = sessionRes.ok ? await sessionRes.json() : null;

            const allEvents = [];
            const seenIds = new Set();
            let cursor = null;
            for (let page = 0; page < 1000; page++) {
                const qs = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
                const evRes = await fetch(`${window.location.origin}/v1/code/sessions/${sessionId}/events${qs}`, {
                    credentials: 'include',
                    headers
                });
                if (!evRes.ok) break;
                const evJson = await evRes.json();
                const items = Array.isArray(evJson.data) ? evJson.data : [];
                for (const ev of items) {
                    if (ev.event_id && seenIds.has(ev.event_id)) continue;
                    if (ev.event_id) seenIds.add(ev.event_id);
                    allEvents.push(ev);
                }
                if (!evJson.next_cursor || evJson.next_cursor === cursor || items.length === 0) {
                    break;
                }
                cursor = evJson.next_cursor;
            }

            allEvents.sort((a, b) => Number(a.sequence_num || 0) - Number(b.sequence_num || 0));
            return { sessionData, events: allEvents };
        } catch (e) {
            console.warn("[Claude Code Web to Markdown] Failed to fetch code session API:", e);
            return null;
        }
    }

    function extractUserEventText(ev) {
        if (!ev || ev.event_type !== 'user') return '';
        const payload = ev.payload || {};
        if (payload.tool_use_result) return '';

        const content = payload.message && payload.message.content;
        if (typeof content === 'string') {
            return content.trim();
        }
        if (Array.isArray(content)) {
            const textParts = [];
            content.forEach(block => {
                if (typeof block === 'string' && block.trim()) {
                    textParts.push(block.trim());
                } else if (block && typeof block === 'object' && block.type === 'text' && block.text) {
                    textParts.push(block.text.trim());
                }
            });
            return textParts.join('\n\n').trim();
        }
        return '';
    }

    function formatToolUseSummary(block, subagentStatsMap) {
        const name = block.name || 'Tool';
        const input = block.input || {};
        if (name === 'Agent') {
            const desc = typeof input.description === 'string' ? input.description.trim() : '';
            const subType = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
            const model = typeof input.model === 'string' ? input.model.trim() : '';
            const stats = block.id && subagentStatsMap ? subagentStatsMap.get(block.id) : null;
            const meta = [subType, model, stats ? `${stats.toolUses} tool uses` : ''].filter(Boolean).join(', ');
            const metaStr = meta ? ` (${meta})` : '';
            return desc ? `> 🤖 **Agent** \`${desc}\`${metaStr}` : `> 🤖 **Agent**${metaStr}`;
        }
        const target = input.file_path || input.path || input.description || input.pattern || input.query || input.url || input.to || input.recipient || '';
        if (typeof target === 'string' && target.trim()) {
            return `> ⚙️ **${name}** \`${target.trim()}\``;
        }
        if (typeof input.command === 'string' && input.command.trim()) {
            const cmd = input.command.trim().split('\n')[0].slice(0, 80);
            return `> ⚙️ **${name}** \`${cmd}\``;
        }
        return `> ⚙️ **${name}**`;
    }

    function extractXmlTag(text, tag) {
        const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
        return m ? m[1].trim() : '';
    }

    function formatAgentMessageBlock(ev, userText) {
        const origin = (ev.payload && ev.payload.origin) || {};
        const fromMatch = userText.match(/<agent-message\s+from="([^"]+)"[^>]*>([\s\S]*?)<\/agent-message>/i);
        const fromId = origin.from || (fromMatch && fromMatch[1]) || '';
        const agentName = origin.name && origin.name !== 'general-purpose' ? origin.name : '';
        const label = [agentName, fromId].filter(Boolean).join(' / ');
        const labelSuffix = label ? ` (\`${label}\`)` : '';

        let body = '';
        if (typeof origin.handbackReportText === 'string' && origin.handbackReportText.trim()) {
            body = origin.handbackReportText.trim();
        } else if (fromMatch && fromMatch[2]) {
            body = fromMatch[2]
                .replace(/^\[Subagent hand-back\][\s\S]*?The report follows:\s*\n?/i, '')
                .replace(/^  /gm, '')
                .trim();
        } else {
            body = userText.replace(/<\/?agent-message[^>]*>/gi, '').trim();
        }

        const safeBody = demoteHeadings(body, 4).replace(/<\/details>/gi, '&lt;/details&gt;');
        return `<details>\n<summary>📨 Subagent Report${labelSuffix}</summary>\n\n${safeBody}\n\n</details>`;
    }

    function formatTaskNotificationBlock(userText) {
        const taskId = extractXmlTag(userText, 'task-id');
        const status = extractXmlTag(userText, 'status') || 'update';
        const summary = extractXmlTag(userText, 'summary');
        const tokens = extractXmlTag(userText, 'subagent_tokens');
        const toolUses = extractXmlTag(userText, 'tool_uses');
        const durationMs = extractXmlTag(userText, 'duration_ms');

        const statsParts = [];
        if (toolUses) statsParts.push(`${toolUses} tool uses`);
        if (tokens) statsParts.push(`${Number(tokens).toLocaleString('en-US')} tokens`);
        if (durationMs) statsParts.push(`${(Number(durationMs) / 1000).toFixed(1)}s`);

        const idPart = taskId ? ` (\`${taskId}\`)` : '';
        const summaryPart = summary ? `: ${summary}` : '';
        const statsPart = statsParts.length > 0 ? ` — ${statsParts.join(', ')}` : '';
        return `> 📋 **Task ${status}**${idPart}${summaryPart}${statsPart}`;
    }

    function formatCodeSessionAPI(sessionData, events) {
        const rawTitle = (sessionData && sessionData.title) ? cleanTitle(sessionData.title) : '';
        const title = rawTitle || getTitle();
        const escapedTitle = title.replace(/"/g, '\\"');
        const sessionModel = (sessionData && sessionData.config && sessionData.config.model)
            || (sessionData && sessionData.external_metadata && (sessionData.external_metadata.last_served_model || sessionData.external_metadata.model))
            || '';
        const createdAt = formatUtc8Timestamp(sessionData && sessionData.created_at);
        const updatedAt = formatUtc8Timestamp(sessionData && sessionData.updated_at);
        const exportedAt = formatUtc8Timestamp(new Date());

        let markdown = `---
parser: "Claude Code Web to Markdown v${SCRIPT_VERSION}"
title: "${escapedTitle}"
url: "${window.location.href}"
`;
        if (sessionModel) {
            markdown += `model: "${String(sessionModel).replace(/"/g, '\\"')}"\n`;
        }
        if (createdAt) {
            markdown += `created_at: "${createdAt}"\n`;
        }
        if (updatedAt) {
            markdown += `updated_at: "${updatedAt}"\n`;
        }
        markdown += `exported_at: "${exportedAt}"
tags:
  - Claude_Code_Web
---

# ${title}

`;

        const subagentStatsMap = new Map();
        events.forEach(ev => {
            const parentId = ev && ev.payload && ev.payload.parent_tool_use_id;
            if (!parentId) return;
            if (!subagentStatsMap.has(parentId)) {
                subagentStatsMap.set(parentId, { toolUses: 0 });
            }
            if (ev.event_type === 'assistant' && ev.payload.message && Array.isArray(ev.payload.message.content)) {
                ev.payload.message.content.forEach(block => {
                    if (block && block.type === 'tool_use') {
                        subagentStatsMap.get(parentId).toolUses++;
                    }
                });
            }
        });

        let userCount = 0;
        let claudeCount = 0;
        let pendingParts = [];
        let pendingModel = '';
        let pendingTimestamp = '';

        function flushClaude() {
            if (pendingParts.length === 0) return;
            claudeCount++;
            const rawModel = (pendingModel || sessionModel || '').replace(/[<>]/g, '').trim();
            const modelMeta = rawModel && rawModel !== 'synthetic' ? ` (${rawModel})` : '';
            const supLine = pendingTimestamp ? `\n<sup>${pendingTimestamp}</sup>` : '';
            const fullText = pendingParts.join('\n\n').trim();
            markdown += `## 🤖 Claude ${claudeCount}${modelMeta}${supLine}\n\n${demoteHeadings(fullText)}\n\n`;
            pendingParts = [];
            pendingModel = '';
            pendingTimestamp = '';
        }

        events.forEach(ev => {
            if (ev.payload && ev.payload.parent_tool_use_id) {
                return;
            }
            if (ev.event_type === 'user') {
                const userText = extractUserEventText(ev);
                if (!userText) return;
                const originKind = ev.payload && ev.payload.origin && ev.payload.origin.kind;
                const evTs = formatSupUtc8Timestamp(ev.created_at || (ev.payload && ev.payload.timestamp));
                if (originKind === 'peer' || /<agent-message\b/i.test(userText)) {
                    if (evTs && !pendingTimestamp) pendingTimestamp = evTs;
                    pendingParts.push(formatAgentMessageBlock(ev, userText));
                    return;
                }
                if (originKind === 'task-notification' || /<task-notification>/i.test(userText)) {
                    if (evTs && !pendingTimestamp) pendingTimestamp = evTs;
                    pendingParts.push(formatTaskNotificationBlock(userText));
                    return;
                }
                if (ev.payload && ev.payload.isSynthetic) {
                    if (evTs && !pendingTimestamp) pendingTimestamp = evTs;
                    pendingParts.push(`\`\`\`text\n${userText.replace(/```/g, '\\`\\`\\`')}\n\`\`\``);
                    return;
                }
                flushClaude();
                userCount++;
                const supLine = evTs ? `\n<sup>${evTs}</sup>` : '';
                markdown += `## 👤 User ${userCount}${supLine}\n\n${demoteHeadings(userText)}\n\n`;
            } else if (ev.event_type === 'assistant') {
                const msg = ev.payload && ev.payload.message;
                if (!msg) return;
                const isSyntheticModel = typeof msg.model === 'string' && msg.model.trim() === '<synthetic>';
                if (typeof msg.model === 'string') {
                    const rawModel = msg.model.trim();
                    if (rawModel && !/^<.*>$/.test(rawModel)) {
                        pendingModel = rawModel;
                    }
                }
                const evTs = formatSupUtc8Timestamp(ev.created_at || (ev.payload && ev.payload.timestamp));
                if (evTs) {
                    pendingTimestamp = evTs;
                }
                const content = msg.content;
                if (typeof content === 'string' && content.trim()) {
                    pendingParts.push(isSyntheticModel ? `> ⚠️ ${content.trim()}` : content.trim());
                } else if (Array.isArray(content)) {
                    content.forEach(block => {
                        if (!block || typeof block !== 'object') return;
                        if (block.type === 'text' && block.text && block.text.trim()) {
                            pendingParts.push(isSyntheticModel ? `> ⚠️ ${block.text.trim()}` : block.text.trim());
                        } else if (block.type === 'thinking' && block.thinking && block.thinking.trim()) {
                            pendingParts.push(`<details>\n<summary>💭 Thinking</summary>\n\n${block.thinking.trim()}\n\n</details>`);
                        } else if (block.type === 'tool_use') {
                            pendingParts.push(formatToolUseSummary(block, subagentStatsMap));
                        }
                    });
                }
            }
        });

        flushClaude();

        if (userCount === 0 && claudeCount === 0) {
            return null;
        }

        return {
            title,
            content: markdown
                .replace(/(?<!`)`\./g, '`\u3000.')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
        };
    }

    function extractContentFromDOM() {
        const title = getTitle();
        const exportedAt = formatUtc8Timestamp(new Date());

        let markdown = `---
parser: "Claude Code Web to Markdown v${SCRIPT_VERSION}"
title: "${title}"
url: "${window.location.href}"
exported_at: "${exportedAt}"
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
            markdown += `## 🤖 Claude ${claudeCount}\n\n${demoteHeadings(fullText)}\n\n`;
            pendingClaude = [];
        }

        rows.forEach(r => {
            const userMsg = r.matches && r.matches('[data-testid="user-message"]') ? r : r.querySelector('[data-testid="user-message"]');
            const asstMsg = r.matches && r.matches('[data-testid="assistant-message"]') ? r : r.querySelector('[data-testid="assistant-message"]');

            if (userMsg) {
                flushClaude();
                userCount++;
                const userText = parseNode(userMsg).trim();
                markdown += `## 👤 User ${userCount}\n\n${demoteHeadings(userText)}\n\n`;
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

            const sessionId = getSessionId();
            if (sessionId) {
                const apiResult = await fetchCodeSessionFromAPI(sessionId);
                if (apiResult && Array.isArray(apiResult.events) && apiResult.events.length > 0) {
                    const parsed = formatCodeSessionAPI(apiResult.sessionData, apiResult.events);
                    if (parsed) {
                        title = parsed.title;
                        markdownContent = parsed.content;
                    }
                }
            }

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
