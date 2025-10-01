// ==UserScript==
// @name         Gemini to Markdown
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Downloads a Gemini chat conversation as a Markdown file.
// @author       You
// @match        https://gemini.google.com/app/*
// @match        https://gemini.google.com/share/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

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
        const button = document.createElement("button");
        button.innerText = "MD";
        button.title = "Download as Markdown";
        button.className = "download-markdown-button";
        button.onclick = downloadMarkdown;
        document.body.appendChild(button);
    }

    function getSanitizedTitle() {
        const titleElement = document.querySelector('h1 strong');
        let title = titleElement ? titleElement.textContent.trim() : 'gemini-chat';
        // Sanitize the title to be a valid filename
        return title.replace(/[^a-z0-9_ \-]/gi, '_').replace(/ /g, '_');
    }

    function parseNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        let childMarkdown = '';
        node.childNodes.forEach(child => {
            childMarkdown += parseNode(child);
        });

        switch (node.tagName.toLowerCase()) {
            case 'p':
                return `\n\n${childMarkdown.trim()}`;
            case 'b':
            case 'strong':
                return `**${childMarkdown}**`;
            case 'i':
            case 'em':
                return `*${childMarkdown}*`;
            case 'ul':
                 return `\n${Array.from(node.children).map(li => `* ${parseNode(li).trim()}`).join('\n')}\n`;
            case 'ol':
                 return `\n${Array.from(node.children).map((li, i) => `${i + 1}. ${parseNode(li).trim()}`).join('\n')}\n`;
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
                 // These are containers, just parse their children
                return childMarkdown;
            default:
                return childMarkdown;
        }
    }

    function parseCodeBlock(codeBlockElement) {
        const langElement = codeBlockElement.querySelector('.code-block-decoration .gds-title-s');
        const lang = langElement ? langElement.textContent.trim().toLowerCase() : '';
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
        let markdown = '';
        const isSharePage = window.location.pathname.startsWith('/share/');

        if (isSharePage) {
            const titleElement = document.querySelector('h1 strong');
            if (titleElement) {
                markdown += `# ${titleElement.textContent.trim()}\n\n`;
            }
        }

        const containerSelector = isSharePage ? '.chat-history' : 'main .conversation-container';
        const turnSelector = isSharePage ? 'share-turn-viewer' : '.conversation-container > *';
        const chatContainer = document.querySelector(containerSelector);

        if (!chatContainer) {
            console.error("Chat container not found.");
            return "Error: Could not find chat container.";
        }

        const turns = chatContainer.querySelectorAll(turnSelector);

        turns.forEach(turn => {
            const userQuery = turn.querySelector('user-query .query-text');
            if (userQuery) {
                markdown += `## User\n${parseNode(userQuery).trim()}\n\n`;
            }

            const modelResponse = turn.querySelector('.markdown');
            if (modelResponse) {
                markdown += `## Gemini\n`;
                 modelResponse.childNodes.forEach(node => {
                    markdown += parseNode(node);
                });
                markdown += '\n\n';
            }
        });

        // Post-processing to clean up excessive newlines
        return markdown.replace(/\n{3,}/g, '\n\n').trim();
    }

    function downloadMarkdown() {
        const markdownContent = extractContent();
        const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${getSanitizedTitle()}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Run the script
    // Use a MutationObserver to wait for the chat to be loaded
    const observer = new MutationObserver((mutations, obs) => {
        const containerSelector = window.location.pathname.startsWith('/share/') ? '.chat-history' : '.conversation-container';
        if (document.querySelector(containerSelector)) {
            addStyles();
            createButton();
            obs.disconnect(); // Stop observing once the container is found
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

})();