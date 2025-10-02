// ==UserScript==
// @name         Gemini to Markdown & PTT Comment Formatter
// @namespace    http://tampermonkey.net/
// @version      0.7
// @description  Downloads a Gemini chat conversation as a Markdown file and formats PTT comments into a table.
// @author       You
// @match        https://gemini.google.com/app/*
// @match        https://gemini.google.com/share/*
// @match        https://www.ptt.cc/bbs/*/*.html*
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // Main execution logic
    if (window.location.hostname === 'www.ptt.cc') {
        function formatPttComments() {
            const pushes = document.querySelectorAll('.push');
            if (pushes.length === 0) {
                return;
            }

            const tableContainer = document.createElement('div');
            tableContainer.style.overflowX = 'auto';

            const table = document.createElement('table');
            table.className = 'ptt-comment-table';
            tableContainer.appendChild(table);

            const pttStyle = `
                .ptt-comment-table {
                    border-collapse: collapse;
                    width: 100%;
                    font-size: 1em;
                    margin-top: 1em;
                    border: 1px solid #ddd;
                }
                .ptt-comment-table th, .ptt-comment-table td {
                    border: 1px solid #ddd;
                    padding: 8px;
                    text-align: left;
                    vertical-align: top;
                }
                .ptt-comment-table th {
                    background-color: #f2f2f2;
                }
                .ptt-comment-table tr:nth-child(even) {
                    background-color: #f9f9f9;
                }
                .ptt-comment-table tr:hover {
                    background-color: #f1f1f1;
                }
                .ptt-comment-table .push-tag,
                .ptt-comment-table .push-userid,
                .ptt-comment-table .push-ipdatetime {
                     white-space: nowrap;
                }
                .push-tag-推 { color: #008000; }
                .push-tag-噓 { color: #ff0000; }
                .push-tag-→ { color: #0000ff; }
            `;
            const styleSheet = document.createElement("style");
            styleSheet.innerText = pttStyle;
            document.head.appendChild(styleSheet);

            const thead = table.createTHead();
            const headerRow = thead.insertRow();
            const headers = ['Tag', 'User', 'Content', 'Time'];
            headers.forEach(headerText => {
                const th = document.createElement('th');
                th.textContent = headerText;
                headerRow.appendChild(th);
            });

            const tbody = table.createTBody();
            pushes.forEach(push => {
                const row = tbody.insertRow();

                const tag = push.querySelector('.push-tag')?.textContent.trim() || '';
                const user = push.querySelector('.push-userid')?.textContent.trim() || '';
                let content = push.querySelector('.push-content')?.textContent.trim() || '';
                if (content.startsWith(':')) {
                    content = content.substring(1).trim();
                }
                const time = push.querySelector('.push-ipdatetime')?.textContent.trim() || '';

                const tagCell = row.insertCell();
                tagCell.textContent = tag;
                tagCell.className = 'push-tag';
                if (tag === '推') tagCell.classList.add('push-tag-推');
                else if (tag === '噓') tagCell.classList.add('push-tag-噓');
                else if (tag === '→') tagCell.classList.add('push-tag-→');

                const userCell = row.insertCell();
                userCell.textContent = user;
                userCell.className = 'push-userid';

                const contentCell = row.insertCell();
                contentCell.textContent = content;
                contentCell.className = 'push-content';

                const timeCell = row.insertCell();
                timeCell.textContent = time;
                timeCell.className = 'push-ipdatetime';
            });

            const mainContent = document.getElementById('main-content');
            if (mainContent) {
                const firstPush = document.querySelector('.push');
                if (firstPush) {
                     mainContent.insertBefore(tableContainer, firstPush);
                } else {
                     mainContent.appendChild(tableContainer);
                }

                pushes.forEach(p => p.remove());

                 const allNodes = Array.from(mainContent.childNodes);
                 let inPushSection = false;
                 for (let i = allNodes.length - 1; i >= 0; i--) {
                     const node = allNodes[i];
                     if (node === tableContainer) {
                         inPushSection = true;
                         continue;
                     }
                     if (!inPushSection) continue;

                     if ((node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('f2'))) && (node.textContent.includes('※ 發信站:') || node.textContent.includes('※ 文章網址:'))) {
                         node.remove();
                     }
                 }
            }
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', formatPttComments);
        } else {
            formatPttComments();
        }

    } else if (window.location.hostname === 'gemini.google.com') {
        // All Gemini-related functions are now encapsulated in this block
        function addStyles() {
            const css = `
                .download-markdown-button {
                    position: fixed; bottom: 20px; right: 20px;
                    background-color: #1a73e8; color: white; border: none; border-radius: 50%;
                    width: 60px; height: 60px; font-size: 24px; cursor: pointer;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.2); z-index: 10000;
                    display: flex; align-items: center; justify-content: center;
                }
                .download-markdown-button:hover { background-color: #185abc; }
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
            if (window.location.pathname.startsWith('/app/')) {
                const firstPrompt = document.querySelector('.query-text p');
                if (firstPrompt) {
                     let title = firstPrompt.textContent.trim().substring(0, 40);
                     return title.replace(/[^a-z0-9_ -]/gi, '_').replace(/ /g, '_');
                }
                return 'gemini-chat';
            }
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
            if (node.nodeType === Node.TEXT_NODE) return node.textContent;
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            if (node.classList.contains('file-preview-container')) return parseFilePreview(node);
            if (node.classList.contains('table-footer')) return '';

            let childMarkdown = '';
            node.childNodes.forEach(child => { childMarkdown += parseNode(child, listLevel); });

            switch (node.tagName.toLowerCase()) {
                case 'p': return `\n\n${childMarkdown.trim()}`;
                case 'h3': return `\n\n### ${childMarkdown.trim()}\n\n`;
                case 'h4': return `\n\n#### ${childMarkdown.trim()}\n\n`;
                case 'h5': return `\n\n##### ${childMarkdown.trim()}\n\n`;
                case 'h6': return `\n\n###### ${childMarkdown.trim()}\n\n`;
                case 'b': case 'strong': return `**${childMarkdown}**`;
                case 'i': case 'em': return `*${childMarkdown}*`;
                case 'ul': case 'ol':
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
                        liText = liText.replace(/^\s*\n|\n\s*$/g, '');
                        listContent += `\n${indent}${marker} ${liText}${nestedList}`;
                    });
                    return listContent;
                case 'li': return childMarkdown;
                case 'hr': return '\n\n---\n\n';
                case 'code': return node.closest('pre') ? childMarkdown : `\`${childMarkdown}\``;
                case 'a': return `[${childMarkdown}](${node.href})`;
                case 'code-block': return parseCodeBlock(node);
                case 'table': return parseTable(node);
                default: return childMarkdown;
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
                if (titleElement) markdown += `# ${titleElement.textContent.trim()}\n\n`;
                const shareLinkElement = document.querySelector('.share-link');
                if (shareLinkElement) markdown += `**Public Link:** ${shareLinkElement.href}\n\n`;
                const publishTimeElement = document.querySelector('.publish-time');
                if (publishTimeElement) markdown += `**Published:** ${publishTimeElement.textContent.trim()}\n\n`;
                markdown += '---\n\n';
            } else {
                 markdown += `# ${getSanitizedTitle()}\n\n`;
            }
            const turns = isSharePage ? document.querySelectorAll('.chat-history share-turn-viewer') : document.querySelectorAll('main .conversation-container');
            if (!turns || turns.length === 0) {
                console.error("Chat content not found.");
                return "Error: Could not find chat content.";
            }
            turns.forEach(turn => {
                const userQuery = turn.querySelector('user-query');
                if (userQuery) markdown += `## User\n${parseNode(userQuery).trim()}\n\n`;
                const modelResponse = turn.querySelector('.markdown');
                if (modelResponse) {
                    markdown += `## Gemini\n`;
                     modelResponse.childNodes.forEach(node => { markdown += parseNode(node); });
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
    }
})();