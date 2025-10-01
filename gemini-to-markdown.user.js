// ==UserScript==
// @name         Gemini to Markdown
// @namespace    http://tampermonkey.net/
// @version      0.2
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
        // For /app pages, title is not easily available, use a default from the first prompt.
        if (window.location.pathname.startsWith('/app/')) {
            const firstPrompt = document.querySelector('.query-text p');
            if (firstPrompt) {
                 let title = firstPrompt.textContent.trim().substring(0, 40);
                 return title.replace(/[^a-z0-9_ -]/gi, '_').replace(/ /g, '_');
            }
            return 'gemini-chat';
        }
        // For /share pages
        const titleElement = document.querySelector('h1 strong');
        let title = titleElement ? titleElement.textContent.trim() : 'gemini-chat';
        return title.replace(/[^a-z0-9_ -]/gi, '_').replace(/ /g, '_');
    }

    function parseFilePreview(filePreviewElement) {
        const fileNameElement = filePreviewElement.querySelector('.new-file-name');
        const fileTypeElement = filePreviewElement.querySelector('.new-file-type');
        const fileName = fileNameElement ? fileNameElement.textContent.trim() : '';
        const fileType = fileTypeElement ? `.${fileTypeElement.textContent.trim()}` : '';
        if (fileName) {
            return `\n> **Attachment:** \`${fileName}${fileType}\`\n`;
        }
        return '';
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
                const indent = '  '.repeat(listLevel);
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
                    // Remove leading/trailing newlines from liText before adding it.
                    liText = liText.replace(/^\s*\n|\n\s*$/g, '');
                    listContent += `\n${indent}${marker} ${liText}${nestedList}`;
                });
                return listContent;
            case 'li':
                return childMarkdown; // Handled by ul/ol logic
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
        const langElement = codeBlockElement.querySelector('.code-block-decoration .gds-title-s');
        const lang = langElement ? langElement.textContent.trim().toLowerCase() : '';
        const codeElement = codeBlockElement.querySelector('code');
        const code = codeElement ? codeElement.textContent : '';
        const header = lang ? `\n> **Code Block:** \`${lang}\`\n` : '\n> **Code Block:**\n';
        return `${header}\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n\n`;
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
        } else {
             markdown += `# ${getSanitizedTitle()}\n\n`;
        }

        let turns;
        if (isSharePage) {
            turns = document.querySelectorAll('.chat-history share-turn-viewer');
        } else {
            turns = document.querySelectorAll('main .conversation-container');
        }

        if (!turns || turns.length === 0) {
            console.error("Chat content not found.");
            return "Error: Could not find chat content.";
        }

        turns.forEach(turn => {
            const userQuery = turn.querySelector('user-query');
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
    const observer = new MutationObserver((mutations, obs) => {
        const readySelector = window.location.pathname.startsWith('/share/') ? '.chat-history' : 'main .conversation-container';
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