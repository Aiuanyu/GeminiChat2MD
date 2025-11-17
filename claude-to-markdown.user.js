// ==UserScript==
// @name         Claude to Markdown
// @namespace    https://github.com/Aiuanyu/GeminiChat2MD
// @version      0.1
// @description  Converts a Claude chat conversation into a Markdown file.
// @author       Aiuanyu
// @match        https://claude.ai/chat/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.1';

    function addStyles() {
        const css = `
            .download-markdown-button {
                position: fixed;
                top: 20px;
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

    function getTitle(firstPromptText) {
        if (firstPromptText) {
            return firstPromptText.trim().substring(0, 40);
        }
        return 'claude-chat';
    }

    function parseNode(node, listLevel = 0) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
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
            case 'strong':
                return `**${childMarkdown}**`;
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
                const codeBlock = node.closest('.relative.group\\/copy');
                const langElement = codeBlock ? codeBlock.querySelector('.text-text-500.font-small') : null;
                const lang = langElement ? langElement.textContent.trim() : '';
                const code = node.querySelector('code');
                return `\n\n\`\`\`${lang}\n${code ? code.textContent.trim() : ''}\n\`\`\`\n\n`;
            default:
                return childMarkdown;
        }
    }

    function extractContent(title) {
        let markdown = `---
parser: "Claude to Markdown v${SCRIPT_VERSION}"
title: "${title}"
url: "${window.location.href}"
tags: Claude
---

# ${title}

`;

        // NOTE: The selectors used here are based on the current Claude UI (as of late 2023)
        // and may break if the UI is updated.
        const turns = document.querySelectorAll('div[data-test-render-count]');
        if (!turns || turns.length === 0) {
            console.error("Chat content not found.");
            return { markdown: "Error: Could not find chat content.", firstPrompt: null };
        }

        let userCount = 0;
        let claudeCount = 0;
        let firstPrompt = null;

        turns.forEach(turn => {
            const userQuery = turn.querySelector('div[data-testid="user-message"]');
            if (userQuery) {
                userCount++;
                const userText = parseNode(userQuery).trim();
                if (!firstPrompt) {
                    firstPrompt = userText;
                }
                markdown += `## User ${userCount}\n\n${userText}\n\n`;
            }

            const modelResponse = turn.querySelector('.font-claude-response-body');
            if (modelResponse) {
                claudeCount++;
                markdown += `## Claude ${claudeCount}\n${parseNode(modelResponse).trim()}\n\n`;
            }
        });

        return { markdown: markdown.replace(/\n{3,}/g, '\n\n').trim(), firstPrompt };
    }

    function downloadMarkdown() {
        const { markdown: markdownContent, firstPrompt } = extractContent("");
        const title = getTitle(firstPrompt);

        const finalMarkdown = markdownContent.replace(`title: ""`, `title: "${title}"`)
                                           .replace(`# `, `# ${title}`);

        const blob = new Blob([finalMarkdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Run the script
    const observer = new MutationObserver((mutations, obs) => {
        const readySelector = 'div[data-testid="user-message"]';
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
