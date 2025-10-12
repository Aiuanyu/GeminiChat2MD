This document provides guidance for AI agents working on this repository.

## General Guidelines

- **Maintain Feature Parity:** When adding a new feature or modifying an existing one in any userscript, you must check if the change is applicable to the other userscripts as well. Strive to maintain feature consistency across all scripts where it makes sense.
- **Update Feature Comparison:** After implementing any feature changes, update the `feature-comparison.md` file to reflect the new state of the userscripts.

## Script-Specific Guidelines

- **`ptt-to-markdown.user.js`:** When updating the `@version`, be sure to also update the top-level `SCRIPT_VERSION` constant. This ensures that the `parser` version in the generated Markdown's frontmatter matches the script's version.
- **Issue-to-Script Mapping:**
  - If an issue title contains `[Gemini]`, modify `gemini-to-markdown.user.js`.
  - If an issue title contains `[Jules]`, modify `jules-to-markdown.user.js`.
  - If an issue title contains `[PTT]`, modify `ptt-to-markdown.user.js`.
  - If an issue title contains `[Threads]`, modify `threads-to-markdown.user.js`.
  - If an issue title contains `[All]`, check all userscripts for required changes.