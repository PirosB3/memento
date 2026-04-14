# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Summon Agents — a Temporal-based platform where users create AI agents that coordinate people over email. Each agent is a persistent identity (e.g. "John") with its own agentmail address. The agent has a **root task** (always-on main thread) that manages **child tasks** (scoped to specific objectives). Each child task gets its own `+uuid` email address for isolated communication.

## Architecture

Four processes compose the system:

1. **@summon/web** (`packages/web`) — Next.js 16 App Router. Agent creation wizard (describe agent → clarifying questions → SOUL/BOUNDARIES/TOOLS review → launch). Agent dashboard with root task conversation viewer, child task creation with clarifying questions, task list with expandable conversations.
2. **@summon/worker** (`packages/worker`) — Temporal worker. Runs `taskWorkflow` for both root and child tasks. Activities include Pi agent turns (LLM + tool execution), task management, and email operations.
3. **@summon/email-gateway** (`packages/email-gateway`) — Polling-based email gateway (15s interval). Routes inbound emails to Temporal signals: `+tag` emails → child task workflow, untagged emails → root task workflow.
4. **@summon/shared** (`packages/shared`) — Prisma client, DB schema, shared types, system prompt builder, logging.

**External dependency**: `repos/pi-mono` — Pi agent framework. Must be built locally with `tsc` before worker can use it. Use the `Agent` class from `@mariozechner/pi-agent-core` (not `createAgentSession` from `pi-coding-agent`). Import from `../../repos/pi-mono/packages/agent/dist/index.js`.

## Root Task vs Child Task Architecture

### Root Task
- Created automatically when an agent is created
- Workflow ID: `agent__{agentId}__root`
- Task row: `tag = "root"`, `isRoot = true`
- Email: base address (e.g. `mario@agentmail.to`) — no `+tag`
- **Is a delegator, not a doer** — receives emails, spawns child tasks, monitors them, maintains memory
- Never completes or fails — only sleeps or escalates
- Has full CRUD tools: `spawn_task`, `wake_task`, `cancel_task`, `list_tasks`, `get_task_conversation`, `agent_config`
- Sees ALL emails in the inbox (unfiltered)

### Child Task
- Created by root's `spawn_task` tool or via web UI
- Workflow ID: `task-{taskId}`
- Task row: `tag = {uuid}`, `isRoot = false`
- Email: `+uuid` address (e.g. `mario+abc123@agentmail.to`)
- Focused on a single objective — cannot spawn or manage other tasks
- Can complete/fail → enters dormant sleep loop (30-day expiry)
- Email tools are **filtered** — can only see emails from threads involving its `+tag` address
- Uses `replyTo` field to... **NO** — uses auto-CC of its `+tag` address on outgoing emails for routing

### Email Routing (Gateway)
- Gateway parses `+tag` from both `to` AND `cc` fields of incoming messages
- `+tag` found → signal child task workflow `task-{taskId}`
- No tag → signal root task workflow `agent__{agentId}__root`
- Orphan tag (task not found) → signal root task
- **Self-sent emails are skipped** (from field contains agent's own address) to prevent self-wake loops

## Key Concepts

- **Task lifecycle**: CREATED → RUNNING → SLEEPING ↔ RUNNING → COMPLETED (child only). Root task: RUNNING ↔ SLEEPING (never completes).
- **Dormant loop** (child tasks only): After completion, task sleeps 24h in a loop. Signals wake it. After 30 days idle, truly terminates.
- **Three signals**: `on_email` (participant replied), `on_owner_response` (owner replied), `on_schedule` (scheduled timer fired). All used by root and child tasks.
- **Two-phase turns**: (1) Wake reflection — short Anthropic SDK call producing `wakeReflection`. (2) Main turn — Pi agent with tools.
- **`decide` tool**: Agent must call at end of every turn. Root: sleep/escalate only. Child: sleep/escalate/complete/fail.
- **`wake_task(taskId, message)` tool**: Root can wake a sleeping/completed child with a message. Errors if task is already RUNNING — root should sleep and retry.
- **Config change detection**: Each turn computes MD5 hash of `soul+boundaries+tools`, compares with `.config_hash` file. If changed, injects ALERT message into conversation.
- **Temporal sandbox**: `workflows.ts` runs in V8 isolate — no Node.js I/O, no Prisma, no Pi agent. All side effects via `proxyActivities`. Activity type signatures are defined inline in the workflow file.

## Tool Sets

### Root Task Tools
| Tool | Description |
|------|-------------|
| `send_email` | Send from base address |
| `reply_email` | Reply from base address |
| `read_email` | Read specific email by ID |
| `read_emails` | List ALL emails (unfiltered) |
| `list_threads` | List ALL threads (unfiltered) |
| `spawn_task` | Create child task (non-blocking) |
| `wake_task` | Wake sleeping child with message (errors if RUNNING) |
| `cancel_task` | Mark child as COMPLETED |
| `list_tasks` | List children with status + last stopReason |
| `get_task_conversation` | Read child's conversation messages |
| `agent_config` | Read/write SOUL, BOUNDARIES, TOOLS |
| `create_schedule` | Schedule a timer for self or child task (fireAt, message, taskId?) |
| `list_schedules` | List all scheduled timers (optionally filter by taskId) |
| `cancel_schedule` | Cancel a pending scheduled timer |
| `bash` | Run shell commands + web browsing via `bb search`, `bb fetch`, `browse` |
| `read_file` / `write_file` | File operations in agent dir |
| `decide` | Sleep or escalate only |

### Child Task Tools
| Tool | Description |
|------|-------------|
| `send_email` | Send with auto-CC of `+tag` address |
| `reply_email` | Reply with auto-CC of `+tag` address |
| `read_email` | Read specific email by ID |
| `read_emails` | **Filtered** — only emails from threads involving `+tag` |
| `list_threads` | **Filtered** — only threads involving `+tag` |
| `create_schedule` | Schedule a timer for self (fireAt, message) |
| `list_schedules` | List own scheduled timers |
| `cancel_schedule` | Cancel own pending scheduled timer |
| `bash` | Run shell commands + web browsing via `bb search`, `bb fetch`, `browse` |
| `read_file` / `write_file` | File operations in agent dir |
| `decide` | Sleep, escalate, complete, or fail |

## AgentMail SDK Quirks

- **`from` field is SILENTLY IGNORED** on `SendMessageRequest` — not in the TypeScript types, and even if passed via `Record<string, unknown>`, it has no effect. Emails always show the base inbox address as sender.
- **`replyTo` field WORKS** — sets the Reply-To header. However, DO NOT use it for `+tag` routing because reply-all includes the replyTo address as a recipient, causing self-send loops.
- **Correct approach for `+tag` routing**: Auto-CC the `+tag` address on outgoing emails. When recipients reply-all, the `+tag` is preserved in CC. Gateway parses CC for routing.
- **Thread `recipients` array** includes `+tag` addresses — use this for client-side email filtering.
- **No server-side filtering** by to/cc/from — must fetch all and filter client-side.
- Use `AgentMailClient` named export (not default). The `send` method expects `to` as a string array.

## Data Model

PostgreSQL (dev: `summon_dev`, test: `summon_test`, prod: managed instance):

### `agents` table
- `agent_id` (PK), `name`, `agent_email` (unique), `owner_email`
- `soul`, `boundaries`, `tools` — agent personality config (mutable via `agent_config` tool)
- `status` — `IDLE` or `RUNNING` (derived in UI from task states)
- `temporal_run_id`, `created_at`

### `tasks` table
- `task_id` (PK, UUID), `agent_id` (FK), `tag` (unique — UUID for children, "root" for root)
- `is_root` — boolean, true for root task
- `objective`, `status` (RUNNING/SLEEPING/ESCALATED/COMPLETED)
- `parent_task_id` (FK, nullable — for forked tasks)
- `temporal_run_id`, `max_turns`, `timeout_hours`
- `last_activity_at`, `created_at`, `completed_at`

### `conversations` table
- `id` (PK), `task_id` (FK), `role`, `message` (JSON), `timestamp`
- Scoped to task — each task has its own conversation history

### `agent_turn_logs` table
- `id` (PK), `task_id` (FK), `turn_number`, `from_state`, `to_state`, `trigger`
- `wake_reflection`, `stop_reason`, `timestamp`

### `schedules` table
- `schedule_id` (PK), `task_id` (FK), `agent_id` (FK), `target_workflow_id`
- `fire_at`, `message`, `status` (PENDING/FIRED/CANCELLED), `created_at`

### `processed_emails` table
- `message_id` (PK), `inbox_id`, `processed_at` — deduplication for gateway

## Commands

```bash
# Start infrastructure (PostgreSQL + Temporal + Temporal UI via Docker)
docker compose up -d

# Start all app services (or use individual commands below)
pnpm dev               # Runs ./scripts/dev.sh — starts infra + all app processes
pnpm dev:worker        # Temporal worker (tsx watch)
pnpm dev:web           # Next.js on :3000
pnpm dev:gateway       # Email polling gateway

# Database (PostgreSQL via Prisma)
pnpm db:generate       # Generate Prisma client after schema changes
pnpm db:migrate:dev    # Create + apply migration during development
pnpm db:migrate:deploy # Apply pending migrations (production-safe, no prompts)
pnpm db:migrate:reset  # Drop the dev DB and re-apply all migrations
dotenv -e .env.test -- pnpm --filter @summon/shared db:migrate:reset  # Reset the test DB
pnpm db:migrate:status # Check migration status
pnpm db:push           # Push schema directly (dev convenience, NOT for prod)
pnpm db:studio         # Open Prisma Studio GUI

# Tests (uses .env.test → summon_test database)
pnpm test
pnpm test:e2e

# Build pi-mono (required before worker can run)
cd repos/pi-mono && npm install
npx tsc -p packages/ai/tsconfig.build.json
npx tsc -p packages/agent/tsconfig.build.json

# Temporal UI: http://localhost:8233
# PostgreSQL: localhost:5432 (user: summon, password: summon)
```

## Environment
### Prerequisites
- **Docker** — runs PostgreSQL, Temporal, and Temporal UI via `docker compose up -d`
- **Node.js >=20** and **pnpm**

### Environment Variables
Copy `.env.example` to `.env` at repo root and fill in:
- `DATABASE_URL` — PostgreSQL connection string (default: `postgresql://summon:summon@localhost:5432/summon_dev`)
- `ANTHROPIC_API_KEY` — required for AI agent turns
- `AGENTMAIL_API_KEY` — required for email operations
- `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` — required for `bb` and `browse`
- `OPENAI_API_KEY` — optional, for any OpenAI-backed workflows

The web package also needs `packages/web/.env.local` with the same keys (Next.js doesn't read from repo root).

### Database Environments
| Environment | Database | Config | Migration strategy |
|-------------|----------|--------|--------------------|
| **dev** | `summon_dev` | `.env` at repo root | `pnpm db:migrate:dev` (creates + applies) |
| **test** | `summon_test` | `.env.test` (committed) | `dotenv -e .env.test -- pnpm --filter @summon/shared db:migrate:reset` |
| **prod** | Managed PostgreSQL | Platform env vars | `pnpm db:migrate:deploy` (applies pending only) |

Both dev and test databases are created automatically by `docker compose up -d` (see `scripts/init-test-db.sql`).

### Prisma v7 Configuration
- **Schema**: `packages/shared/prisma/schema.prisma` — defines models and PostgreSQL provider
- **Config**: `packages/shared/prisma.config.ts` — provides `DATABASE_URL` to Prisma CLI (for migrations)
- **Client**: `packages/shared/src/db.ts` — uses `@prisma/adapter-pg` driver adapter
- **Migrations**: `packages/shared/prisma/migrations/` — committed to git, applied in order

### Browserbase
Agents use `bb` CLI (search, fetch) and `browse` CLI (interactive browsing) via their bash tool. Both CLIs must be installed globally (`npm install -g @browserbasehq/cli @browserbasehq/browse-cli`). Browse CLI is set to remote mode (`browse env remote`) for anti-bot/CAPTCHA support.

## Monorepo

pnpm workspaces. Cross-package references use `"@summon/shared": "workspace:*"`. Node.js >=20 required.

## Agent Working Directories

Each agent gets `packages/worker/agents/{agent_id}/` containing:
- `memory.md` — free-form, agent-curated knowledge (injected into every system prompt)
- `contacts.json` — structured per-person knowledge
- `.config_hash` — MD5 hash of soul+boundaries+tools for change detection
- `tasks/{tag}/notes.md` — per-child-task notes (child tasks only)

## Logging

All packages use `createLogger(context)` from `@summon/shared`. Logs write to:
- **Console** (stdout/stderr) — for dev
- **`data/summon.log`** — persistent file, all levels (DEBUG/INFO/WARN/ERROR)

Log format: `{ISO timestamp} [{LEVEL}] [{context}] {message}\n  {optional data}`

Child loggers via `.child(subContext)` — e.g. `log.child("task:abc123")` produces `[pi-turn:task:abc123]`.

Logger finds the log dir by walking up from cwd looking for `pnpm-workspace.yaml` or `data/` directory.

## System Prompt Structure

Built by `buildSystemPrompt()` in `packages/shared/src/system-prompt.ts`. Differs for root vs child:

**Root-specific sections**: YOUR ROLE (delegator), TASK MANAGEMENT (spawn/wake/cancel/list), SELF-EVOLUTION (agent_config), CHILD TASKS list.

**Child-specific sections**: YOUR ROLE (focused worker), EMAIL ISOLATION note.

**Shared sections**: SOUL, BOUNDARIES, TOOLS, CURRENT TASK, CONTEXT, AGENT MEMORY, CONTACTS, TURN HISTORY, WAKE REFLECTION, MEMORY rules, EMAIL RULES, OWNER STEERING, YOUR TASK steps.

## Web UI Routes

```
/agents              — List all agents with derived status + active task count
/agents/new          — 4-step wizard: describe agent → questions → review config → done
/agents/[id]         — Agent dashboard: root task convo, child task list with new-task form
```

### API Routes
```
POST   /api/agents                    — Create agent + root task + start root workflow
GET    /api/agents                    — List agents with task counts
GET    /api/agents/[id]               — Agent detail with all tasks
PUT    /api/agents/[id]               — Update soul/boundaries/tools
POST   /api/agents/[id]/restart       — Restart the agent's root + child workflows
POST   /api/agents/prepare            — Generate clarifying questions for agent creation
POST   /api/agents/generate           — Generate SOUL/BOUNDARIES/TOOLS/NAME from Q&A
GET    /api/agents/[id]/tasks         — List child tasks
POST   /api/agents/[id]/tasks         — Create child task + start workflow directly
POST   /api/agents/[id]/tasks/prepare — Generate clarifying questions for task creation
```

## Workflow IDs

- Root task: `agent__{agentId}__root`
- Child task: `task-{taskId}`
- Schedule timer: `schedule-{scheduleId}`
- Task queue: `summon-agents`

## Test Data Rules

**Never use real or real-looking email domains in tests, fixtures, or examples.** Only use RFC 2606 / RFC 6761 reserved domains: `example.com`, `example.org`, `example.net`, or `*.example`, `*.test`, `*.invalid`, `*.localhost`. These are guaranteed to never resolve to a real inbox. Using anything else — even a domain that "looks fake" — risks leaking a real address into committed code, test snapshots, or log output. If you encounter non-reserved domains in existing test data, replace them.

## Important Implementation Notes

1. **Activity timeout**: `startToCloseTimeout: "10m"` — Pi agent turns can take a while with many tool calls. Was originally 5m, caused timeouts.
2. **Agent status in UI is derived**: `RUNNING` if any task (root or child) is RUNNING/ESCALATED, `IDLE` otherwise. The `agent.status` DB field is set to RUNNING on creation but the UI computes it dynamically.
3. **Prisma client regeneration**: After schema changes, run `pnpm db:migrate:dev` (creates migration + regenerates client) AND restart the web server (Next.js caches the Prisma client).
4. **No dispatcher workflow**: The previous `dispatcherWorkflow` was removed. The root task IS the dispatcher. All routing goes through the gateway → root or child task directly.
5. **Self-send prevention**: Gateway skips emails where `from` contains the agent's own address prefix. This prevents CC-to-self from creating infinite wake loops.
6. **Task creation from UI**: Child tasks are started via Temporal client directly (`temporal.workflow.start`), NOT by signaling the root task. Root discovers new tasks via `list_tasks()`.
7. **Task clarifying questions**: Both agent creation and task creation have a "prepare" step that generates 3-5 clarifying questions via Claude (Sonnet for speed). Answers are appended to the objective.
