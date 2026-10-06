# HeyAgent — agent operating notes (repo)

Product core (do not gut for OpenClaw cosplay):
- Desktop harnesses: Telegram chat-until, browser/quiz, YouTube quick-open, notepad genre fidelity
- Identity: name + pixel sprites + `~/.heyagent/workspace/{SOUL,AGENTS,MEMORY}.md`
- Orchestrator: route → plan → harness / LLM loop with VERIFY
- Coding agent: `packages/agent/src/native-coder.ts` is THE coding loop for all models
  (tools: workspace_list/read/write/shell/check; read-back writes, node --check,
  tsc --noEmit, npm test/build, pytest; destructive shell blocked; folder-sandboxed).
  CLI: `hey code "task" [--cwd dir]`; chat: `/cwd <dir>`; desktop: sidebar folder.

Infrastructure borrowed from OpenClaw ideas (thin ports):
- Model failover (`packages/models/src/failover.ts`)
- Session lane queue (`packages/agent/src/session-queue.ts`)
- Tool-loop breaker (`packages/agent/src/tool-loop.ts`)
- Workspace soul files (`packages/identity/src/workspace.ts`)

Do not import `.vendor/openclaw` as a runtime dependency.
Do not auto-mark plan steps done without tool evidence.
