This document provides guidance for AI agents working on this repository.

## General Guidelines

- **Maintain Feature Parity:** When adding a new feature or modifying an existing one in any userscript, you must check if the change is applicable to the other userscripts as well. Strive to maintain feature consistency across all scripts where it makes sense.
- **Update Feature Comparison:** After implementing any feature changes, update the `feature-comparison.md` file to reflect the new state of the userscripts. Also, ensure the version number in this file is updated to match the script's new version.
- **Synchronized Versioning:** For userscripts that contain a `SCRIPT_VERSION` constant (e.g., `jules-`, `ptt-`, `threads-to-markdown.user.js`), ensure that it is kept in sync with the `@version` in the userscript header. This ensures that the `parser` version in the generated Markdown's frontmatter matches the script's version.
- **Add History Entries:** When updating a userscript, you must add a `@history` tag to the metadata block summarizing the changes for the new version.

## Issue-to-Script Mapping
If an issue title contains:
- `[Gemini]`, modify `gemini-to-markdown.user.js`.
- `[Jules]`, modify `jules-to-markdown.user.js`.
- `[Claude]`, modify `claude-to-markdown.user.js`.
- `[Claude Code Web]`, modify `claude-code-web-to-markdown.user.js`.
- `[PTT]`, modify `ptt-to-markdown.user.js`.
- `[Threads]`, modify `threads-to-markdown.user.js`.
- `[GitHub]`, modify `github-pr-to-markdown.user.js`.
- `[All]`, check all userscripts for required changes.