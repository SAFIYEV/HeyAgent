# Desktop workspace

The desktop app uses a three-column layout: local chat history, the current conversation, and a collapsible environment/approval panel. It retains the agent identity, avatars, onboarding, missions, model checks and integration setup.

Run `npm run build`, then `npx hey gateway start`, then `npm run dev:desktop`.

## Chats

New chats have independent agent session IDs. Titles and visible messages are saved in this Electron renderer's local storage; this is not a synchronized project or Telegram history. Switching chats is disabled while a request is running. Enter sends; Shift+Enter inserts a newline. Ctrl+N opens a new chat. The model button opens model settings; it does not change the active model.

## Skills

The Skills view reads installed skills from `GET /skills`. Users can search, inspect complete instructions and select up to six skills. Selections appear in the composer and are submitted through `POST /chat` as `skillNames`. Unknown names fail before task execution. Explicit skills receive priority and their full instructions enter the model context. Explicit selection uses the general tool loop so a deterministic harness cannot silently ignore those instructions; cancellation keeps its existing route. Requests without explicit selection retain their existing harness behavior and automatic skill selection.

Install custom instruction folders at `~/.heyagent/skills/<name>/SKILL.md`, with `name` and `description` frontmatter. The catalog reloads when opened. Selecting a skill does not install dependencies or grant extra tool permissions.

## Verification

`npx electron apps/desktop/scripts/smoke-ui.cjs` runs the actual renderer against an isolated mock HTTP server. It checks skill selection/request payloads, safe message rendering, independent chats, history reload, narrow layout and offline states. Screenshots go to ignored `out/ui-check`. It never calls a real model or connected service.

Runtime status uses correlated WebSocket events; chat results still use HTTP. Service badges report saved connection status, not live credential validity. This release does not add Git worktrees, cloud execution or subagents.
