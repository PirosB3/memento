# Summon Agents — PRD

**Author:** ${OWNER_NAME} & Claude
**Date:** April 1, 2026
**Status:** Draft v6

---

## Problem

Coordinating a group of people over email (scheduling dinners, planning trips, collecting RSVPs) is tedious, asynchronous, and full of back-and-forth. You end up being the "coordinator tax" — the person who nudges, remembers constraints, and proposes compromises. This is work a stateful agent can do autonomously.

## Solution

A simple web UI where you type an objective and participant emails, hit go, and spin up a single-purpose agent. The agent gets its own email address (via agentmail), talks to participants directly, tracks state across days of async replies, and only escalates to you via your personal email when it hits a decision it can't make.

Each agent is a Temporal workflow. Each "turn" is a state machine cycle: wake → read context → think (LLM) → act → sleep.

---

## Core Concepts

### Agent

A Temporal workflow instance hydrated from a database record. Each agent has four defining attributes set at creation time:

- **SOUL** — who the agent *is*. Its personality, voice, communication style, and approach. Generated from the owner's prompt + clarifying Q&A. Example: "You are warm but efficient. You write like a friend texting, not a corporate assistant. You use first names, keep it brief, and add a touch of humor."
- **BOUNDARIES** — what the agent *can and cannot do*. Hard constraints, escalation triggers, information it must not share, behavioral limits. Example: "Never share the owner's calendar details with participants. Never commit to a budget over $200 without escalating. Always escalate if a participant asks to speak to a human."
- **TOOLS** — what the agent *has access to*. For V1, every agent gets: email (send/receive via agentmail), a bash shell (run any command), and a sandboxed filesystem (`/agents/{agent_id}/`). The TOOLS field is a natural language description of capabilities so the LLM knows what it can do.
- **Email address** — a unique agentmail address (e.g. `dinner-plan-7f3a@agent.mail`)

Plus:
- A state machine governing its lifecycle
- A memory store (conversation history, extracted facts, decisions)

### Turn

One cycle of the agent loop:

1. **Wake** — triggered by one of exactly three signals (see Signals below)
2. **Read** — load conversation history, extracted facts, and any new context (emails, calendar data)
3. **Think** — LLM call with system prompt + accumulated context → structured decision
4. **Act** — execute the decision (send emails, propose times, escalate, complete)
5. **Sleep** — register wake conditions (await email reply, set timeout, or both)

### Signals (exactly three types)

Every transition into RUNNING is caused by one of these signals. There are no other wake mechanisms.

1. **Email signal** — a participant replied to the agent's email address. The email gateway receives it and sends a Temporal signal to the workflow.
2. **Wake signal** — a Temporal timer expired (e.g. "24h with no replies"). The workflow wakes itself.
3. **Owner signal** — the owner (you) replied to an escalation email sent to your personal email. The email gateway recognizes the thread and routes it as a Temporal signal.

### Agent Creation Flow

The entry point is a simple web UI with a conversational creation wizard:

**Step 1 — Input prompt**
Owner types a free-text objective: "Schedule dinner with Alice, Bob, Carol for next Fri or Sat in West Village."

**Step 2 — Clarifying questions (LLM-generated)**
The system makes an LLM call that reads the objective and generates 4-5 targeted questions. Examples:
- "What's the vibe? Casual catch-up or a special occasion?"
- "Any budget constraints for the restaurant?"
- "Should I loop everyone into one thread, or email them individually?"
- "If there's a scheduling conflict, who takes priority?"
- "Anything off-limits I should know about? (dietary restrictions, neighborhoods to avoid, etc.)"

Owner answers inline in the UI.

**Step 3 — Generate SOUL, BOUNDARIES, TOOLS**
A second LLM call takes the objective + answers and outputs:
- **SOUL**: the agent's personality and communication style
- **BOUNDARIES**: hard constraints and escalation rules
- **TOOLS**: natural language description of available capabilities

These are shown to the owner for review/edit before launch.

**Step 4 — Provision and launch**
On confirmation:
1. Provision agentmail address
2. Write full record to SQLite `agents` table (soul, boundaries, tools, objective, email, etc.)
3. Start Temporal workflow (passes `agent_id` — workflow hydrates from DB)
4. UI shows agent email + live status

---

## State Machine

```
                    ┌─────────────────────────────┐
                    │                               │
                    ▼                               │
CREATED ──► RUNNING ──► SLEEPING ──► (trigger) ────┘
               │                        │
               ├──► ESCALATED ──► (owner responds) ──► RUNNING
               │
               ├──► COMPLETED
               │
               └──► FAILED
```

| State | Description | Transitions Out |
|-------|-------------|-----------------|
| CREATED | Agent provisioned, email assigned. Has not yet acted. | → RUNNING (first turn) |
| RUNNING | Actively processing a turn (LLM call, sending emails). | → SLEEPING, ESCALATED, COMPLETED, FAILED |
| SLEEPING | Waiting for a trigger. Has registered wake conditions. | → RUNNING (on trigger) |
| ESCALATED | Agent hit a decision it cannot make autonomously. Owner notified. | → RUNNING (on owner input) |
| COMPLETED | Objective achieved. Summary sent to owner. Agent archived. | Terminal |
| FAILED | Unrecoverable error after retries. Owner notified. | Terminal |

### Wake Conditions (set when entering SLEEPING)

An agent sleeps with one or more registered conditions. The first condition to fire wakes the agent:

- **Email signal** — a participant replied (Temporal signal from email gateway)
- **Wake signal** — timer expired (Temporal timer, e.g. 24h)

When ESCALATED, the agent waits on a single condition:

- **Owner signal** — the owner replied to the escalation email (Temporal signal from email gateway, matched by thread)

### Escalation Policy

The agent escalates when:

- Conflicting constraints with no clear resolution (e.g. two people can only do different days)
- Budget/preference decision the owner should make (e.g. "the only available restaurant is $$$")
- Participant explicitly asks to talk to a human
- Max turn count exceeded without progress (configurable, default: 20)

On escalation, the agent emails the owner with context and a clear question. The owner replies, and the agent resumes.

---

## Temporal Workflow (Pseudocode)

```python
@workflow.defn
class AgentWorkflow:

    def __init__(self):
        self.state = "CREATED"
        self.email_queue = []
        self.owner_response = None

    @workflow.signal
    def on_email(self, email: InboundEmail):
        """Temporal signal — fired by email gateway on inbound mail."""
        self.email_queue.append(email)

    @workflow.signal
    def on_owner_response(self, message: str):
        """Owner replied to an escalation."""
        self.owner_response = message

    @workflow.run
    async def run(self, agent_id: str):
        # Hydrate from SQLite — SOUL, BOUNDARIES, TOOLS, objective, participants, owner
        agent = await workflow.execute_activity(load_agent_from_db, agent_id)
        self.memory.set_objective(agent.objective)
        self.memory.set_participants(agent.participants)
        self.agent = agent  # carries soul, boundaries, tools for prompt assembly

        # First turn: introduce yourself
        self.state = "RUNNING"
        # Insert initial wake message into conversations table
        await workflow.execute_activity(
            insert_conversation_message, agent_id,
            {"role": "user", "content": "AWAKEN BY=created\n\nYou are a new agent. Begin working on your objective."}
        )
        decision = await self._run_turn()
        self.state = "SLEEPING"

        # Main loop
        while self.state not in ("COMPLETED", "FAILED"):
            # Wait for trigger: new email, timer, or owner signal
            triggered = await workflow.wait_condition(
                lambda: len(self.email_queue) > 0,
                timeout=decision.sleep_duration  # e.g. timedelta(hours=24)
            )

            self.state = "RUNNING"

            # Insert wake message into conversations table
            if self.email_queue:
                emails = self.email_queue.copy()
                self.email_queue.clear()
                for email in emails:
                    await workflow.execute_activity(
                        insert_conversation_message, agent_id,
                        {"role": "user", "content": f"AWAKEN BY=email FROM={email.sender}\n\nSubject: {email.subject}\nBody: {email.body}\n\nPlease proceed with your objective."}
                    )
            elif not triggered:
                await workflow.execute_activity(
                    insert_conversation_message, agent_id,
                    {"role": "user", "content": f"AWAKEN BY=sleep DURATION={decision.sleep_duration}\n\nNo new emails received during sleep period.\n\nPlease proceed. Check who hasn't replied and decide next steps."}
                )

            decision = await self._run_turn()

            if decision.type == "complete":
                self.state = "COMPLETED"
                await workflow.execute_activity(
                    send_email, agent.owner_email, "Task complete", decision.summary
                )
                await workflow.execute_activity(update_agent_status, agent_id, "COMPLETED")
            elif decision.type == "fail":
                self.state = "FAILED"
                await workflow.execute_activity(
                    send_email, agent.owner_email, "Agent failed", decision.error
                )
                await workflow.execute_activity(update_agent_status, agent_id, "FAILED")
            elif decision.type == "escalate":
                self.state = "ESCALATED"
                await workflow.execute_activity(
                    send_email, agent.owner_email, "Need your input", decision.question
                )
                await workflow.wait_condition(
                    lambda: self.owner_response is not None
                )
                # Insert owner reply as conversation message
                await workflow.execute_activity(
                    insert_conversation_message, agent_id,
                    {"role": "user", "content": f"AWAKEN BY=owner\n\nOwner response: \"{self.owner_response}\"\n\nPlease proceed with the owner's decision."}
                )
                self.owner_response = None
                self.state = "RUNNING"
            else:
                self.state = "SLEEPING"

    async def _run_turn(self) -> Decision:
        """Run a full agent turn via Pi agent.

        Pi agent handles:
        1. Load conversation from `conversations` table (via Prisma)
        2. Build system prompt from SOUL/BOUNDARIES/TOOLS
        3. Call Opus 4.6
        4. Execute tool calls (bash, file I/O, send_email)
        5. Append all messages to `conversations` table
        6. Return structured decision (act/escalate/complete/fail)
        """
        return await workflow.execute_activity(
            run_pi_agent_turn,
            self.agent.agent_id,
            start_to_close_timeout=timedelta(seconds=120),
            retry_policy=RetryPolicy(max_attempts=2)
        )
```

---

## Components

### 1. Next.js App (UI + API)

A Next.js app with Prisma for DB access. Handles both the frontend and API routes.

**Pages:**
- `/agents/new` — the creation wizard (prompt → questions → review SOUL/BOUNDARIES/TOOLS → launch)
- `/agents` — table of all agents with status, created date, objective preview (full CRUD)
- `/agents/:id` — live status, email address, conversation history, and the SOUL/BOUNDARIES/TOOLS (editable)

**API Routes (Next.js `/api/`):**
```
# Step 1: Generate clarifying questions from objective
POST /api/agents/prepare
{
  "objective": "Schedule dinner with Alice, Bob, Carol for next Fri or Sat in West Village",
  "participants": ["alice@email.com", "bob@email.com", "carol@email.com"]
}
Response: { "questions": ["What's the vibe?", "Budget?", ...] }

# Step 2: Generate SOUL/BOUNDARIES/TOOLS from objective + answers
POST /api/agents/generate
{
  "objective": "...",
  "participants": [...],
  "answers": {"q1": "Casual catch-up", "q2": "Under $50/person", ...}
}
Response: { "soul": "...", "boundaries": "...", "tools": "..." }

# Step 3: Create the agent (after owner reviews/edits)
POST /api/agents
{
  "objective": "...",
  "participants": ["alice@email.com", "bob@email.com", "carol@email.com"],
  "owner_email": "${OWNER_EMAIL}",
  "soul": "...",
  "boundaries": "...",
  "tools": "...",
  "max_turns": 20,
  "timeout_hours": 72
}
Response:
{
  "agent_id": "dinner-plan-7f3a",
  "agent_email": "dinner-plan-7f3a@agent.mail",
  "status": "CREATED"
}
```

### 2. Email Gateway

Bridges email ↔ Temporal signals. Handles all three signal types.

**Inbound flow (participant reply → email signal):**
1. Email arrives at `<agent-id>@agent.mail`
2. Gateway extracts agent ID from the local part
3. Gateway sends Temporal signal `on_email` to the workflow
4. Payload: sender, subject, body (plaintext), timestamp

**Inbound flow (owner reply to escalation → owner signal):**
1. Escalation emails are sent FROM the agent's address TO the owner's personal email
2. Owner replies directly (hits the agent's address)
3. Gateway recognizes sender = owner_email → sends Temporal signal `on_owner_response` instead of `on_email`
4. This distinction is critical: owner responses resume from ESCALATED, participant replies resume from SLEEPING

**Outbound flow:**
1. Workflow executes `send_email` activity
2. Activity calls email gateway API
3. Gateway sends via agentmail SMTP with the agent's address as `From`

**Implementation:** agentmail SDK + a webhook receiver (FastAPI).

### 3. LLM Decision Engine

A Temporal activity that calls the LLM and returns a structured decision. The system prompt is assembled from the agent's DB record (SOUL, BOUNDARIES, TOOLS).

**Input:** system prompt (built from DB) + conversation history + extracted facts + current state

**Output:**
```python
@dataclass
class Decision:
    type: Literal["act", "escalate", "complete", "fail"]
    reasoning: str                    # chain-of-thought (logged, not sent)
    actions: list[Action]             # things to do
    sleep_duration: timedelta | None  # how long to wait if no trigger
    summary: str | None               # for "complete" type
    question: str | None              # for "escalate" type
    error: str | None                 # for "fail" type

@dataclass
class Action:
    type: Literal["send_email", "bash", "write_file", "read_file"]
    params: dict
    # send_email: {to, subject, body}
    # bash: {command}           — run any shell command
    # write_file: {path, content}  — write to /agents/{agent_id}/
    # read_file: {path}           — read from /agents/{agent_id}/
```

**System prompt structure (assembled from DB fields):**
```
## SOUL
{agent.soul}

## BOUNDARIES
{agent.boundaries}

## TOOLS
{agent.tools}

## OBJECTIVE
{agent.objective}

## CONTEXT
Owner: {agent.owner_email}
Participants: {participants}
Current state: {state}
Turn number: {turn_count} / {max_turns}

## Conversation so far
{formatted_email_history}

## Extracted facts
{facts}

## MEMORY
Your working directory is /agents/{agent_id}/. You should maintain:
- memory.md    — running scratchpad with your current understanding
- facts.json   — structured facts you've extracted (who said what, constraints)
Read these at the start of every turn. Update them after every turn.

## Your task
1. Read memory.md and facts.json to recall where you left off.
2. Process the wake trigger (see the most recent user message for what happened).
3. Decide what to do next. Return a JSON decision with type, reasoning, actions, and sleep_duration.
4. AFTER acting, you MUST update memory.md and facts.json. This is non-negotiable.
```

**How conversation flows through the system:**
1. On wake, the Temporal workflow inserts a `user` message into the `conversations` table (e.g. `AWAKEN BY=email FROM=alice@...`)
2. The full conversation is loaded from the table and sent to the LLM
3. The LLM's response (reasoning + tool calls + actions) is the `assistant` message, appended to the table
4. Tool results are appended as tool-result messages
5. The agent goes to sleep → next wake starts at step 1

The conversation table IS the agent's memory. The filesystem files (`memory.md`, `facts.json`) are the agent's self-maintained scratchpad for quick context reconstruction when the conversation gets long.

The key insight: SOUL governs *how* the agent communicates, BOUNDARIES govern *what it's allowed to do*, TOOLS tell it *what capabilities are available*, and the conversation table gives it full continuity across turns.

### 4. Conversation Store (SQLite) + Filesystem Journal

The agent's conversation history is the source of truth, stored in a SQLite table:

```sql
CREATE TABLE conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
    role        TEXT NOT NULL,          -- "user", "assistant", "system"
    message     TEXT NOT NULL,          -- JSON-serialized LLM message
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),

    -- Index for fast reconstruction
    CONSTRAINT idx_agent_time UNIQUE (agent_id, timestamp, id)
);
```

**How it works:** Each turn of the agent is literally an LLM conversation. The full message history (system prompt, user messages, assistant responses, tool calls and results) is serialized as JSON and stored row-by-row. To reconstruct the conversation for the next turn, query `SELECT * FROM conversations WHERE agent_id = ? ORDER BY id` and deserialize.

**Wake triggers are user messages.** When the agent wakes up, the system injects a `user` message into the conversation table that tells the agent what happened:

```json
// Email signal — participant replied
{"role": "user", "content": "AWAKEN BY=email FROM=alice@example.com\n\nSubject: Re: Dinner Friday?\nBody: Friday works for me!\n\nPlease proceed with your objective. Read your journal and memory files to recall context."}

// Wake signal — timer expired
{"role": "user", "content": "AWAKEN BY=sleep DURATION=24h\n\nNo new emails received during sleep period.\n\nPlease proceed with your objective. Check who hasn't replied and decide next steps."}

// Owner signal — owner replied to escalation
{"role": "user", "content": "AWAKEN BY=owner\n\nOwner response: \"Go with Friday. Tell Carol we'll get her next time.\"\n\nPlease proceed with the owner's decision."}
```

This is elegant because:
1. The agent sees its full history as a normal LLM conversation — no special reconstruction logic
2. Wake triggers are just user messages with structured prefixes — the LLM naturally understands them
3. The assistant's response (with tool calls for sending emails, running bash, etc.) gets appended to the same table
4. You can replay or debug any agent by reading the conversation table chronologically

**Filesystem is still used for the agent's working directory** (`/agents/{agent_id}/`) — scripts, data files, API responses, drafts, etc. But the conversation table replaces the journal as the primary audit trail. The agent is still encouraged to maintain `memory.md` and `facts.json` on disk as a scratchpad it reads back each turn, but the canonical history is in the DB.

### 5. Action Executors (Temporal Activities)

Each action is a Temporal activity. The model is intentionally generous — bash gives the agent full flexibility. No sandboxing for V1; the owner controls who the agents interact with.

| Activity | Input | Output | Retry | Notes |
|----------|-------|--------|-------|-------|
| `provision_email` | agent_id | email address | 3x | One-time setup |
| `send_email` | to, subject, body, agent_email | message_id | 3x | Via agentmail SDK |
| `run_bash` | command, agent_id | stdout/stderr + exit code | 1x | `cwd=/agents/{agent_id}/`. Timeout: 120s. |
| `write_file` | path, content, agent_id | success/fail | 1x | Agent's directory |
| `read_file` | path, agent_id | file contents | 1x | Agent's directory |

**Why bash?** Instead of building typed activities for every possible action (check calendar, book restaurant, search the web, parse a PDF), the agent just runs commands. Need to check a calendar? `curl` the Google Calendar API. Need to search for restaurants? `curl` + `jq`. Need to do math? `python3 -c "..."`. This is maximally flexible and trivial to implement — the activity is literally `subprocess.run()` with `cwd` set to the agent's directory.

**No sandbox (V1).** Agents run unsandboxed on the host. This is intentional — for V1, the owner only creates agents for people they know and trust. The tradeoff: maximum simplicity and zero container overhead. Each agent still gets its own directory at `/agents/{agent_id}/` as a convention, and the agent is instructed to stay within it, but there's no hard enforcement.

**Memory maintenance:** After every turn, the agent MUST update `memory.md` and `facts.json` in its working directory. This is enforced in the system prompt. These files are the agent's quick-access scratchpad; the canonical audit trail is the `conversations` table in SQLite (every LLM message is persisted automatically).

---

## Example Flow: "Schedule dinner with 4 friends"

**Creation — Web UI wizard**
Owner types: "Schedule dinner with Alice, Bob, Carol for next Fri or Sat evening, somewhere in West Village."
System asks: "What's the vibe?" → "Casual." "Budget?" → "Under $50/person." "Priority if conflict?" → "Alice, then Bob."
System generates:
- SOUL: "Warm, casual tone. Use first names. Keep emails under 3 sentences. Light humor OK."
- BOUNDARIES: "Never share the owner's other calendar events. Budget cap $50/person — escalate if exceeded. Alice's schedule takes priority over Carol's. Max 2 nudges per person."
- TOOLS: "Bash shell, filesystem, email. Google Calendar API via $GCAL_TOKEN."
Owner reviews, tweaks boundary wording, hits "Launch."

**Turn 0 — CREATED → RUNNING**
Backend provisions `dinner-7f3a@agent.mail`, writes agent record to SQLite, starts Temporal workflow.
System inserts into `conversations`: `{"role": "user", "content": "AWAKEN BY=created\n\nYou are a new agent. Read your SOUL, BOUNDARIES, and TOOLS. Begin working on your objective."}`
LLM sees: system prompt (SOUL/BOUNDARIES/TOOLS/OBJECTIVE) + this first user message.
Agent responds: sends 3 individual emails, initializes `memory.md` and `facts.json`.
Assistant response + tool results appended to `conversations` table.
→ SLEEPING (wake: email | 24h timer)

**Turn 1 — SLEEPING → RUNNING**
Alice replies: "Friday works!"
System inserts: `{"role": "user", "content": "AWAKEN BY=email FROM=alice@example.com\n\nSubject: Re: Dinner?\nBody: Friday works for me!"}`
LLM sees: full conversation so far (system + turn 0 + this new message).
Agent reads `memory.md`, extracts fact `Alice → Friday`, updates `facts.json` and `memory.md`.
Still waiting on Bob, Carol.
→ SLEEPING

**Turn 2 — SLEEPING → RUNNING**
Bob replies: "Either works for me"
Agent extracts: `Bob → Fri or Sat`
Still waiting Carol.
→ SLEEPING

**Turn 3 — SLEEPING → RUNNING (timeout)**
24h passed. Carol hasn't replied. Agent sends nudge:
> "Hey Carol! Just checking in — does Friday or Saturday evening work for dinner in the West Village?"

→ SLEEPING (wake: email | 12h timer)

**Turn 4 — SLEEPING → RUNNING**
Carol replies: "I can only do Saturday"
Agent extracts: `Carol → Saturday only`
Conflict detected: Alice=Fri only, Carol=Sat only.
→ ESCALATED

Agent emails the owner (`${OWNER_EMAIL}`):
> "Quick decision needed: Alice can only do Friday, Carol can only do Saturday. Bob is flexible. Should I go with Friday (without Carol) or Saturday (without Alice)?"

**Turn 5 — ESCALATED → RUNNING**
Owner replies to the email: "Friday. Tell Carol we'll get her next time."
Email gateway matches sender=owner → fires `on_owner_response` signal.
Agent sends:
- To Alice & Bob: "Friday it is! I'll send details once the owner picks a spot."
- To Carol: "This one's landing on Friday — we'll loop you in next time!"
- To the owner: "All set. Friday dinner with Alice & Bob in the West Village. Carol can't make it. Want me to find a restaurant?"

→ COMPLETED

---

## Tech Stack (MVP)

| Layer | Choice | Rationale |
|-------|--------|-----------|
| UI + API | **Next.js** + **Prisma** | Full-stack in one repo. Server actions for API, React for the creation wizard + dashboard. Prisma for type-safe DB access. |
| Database | **SQLite** (via Prisma) | `agents` + `conversations` tables. Zero-ops, single file, Prisma has SQLite support. |
| Workflow engine | **Temporal** (self-hosted or Cloud) | Durable execution, signals, timers, retries — all built in |
| Agent runtime | **Pi agent** | Agent harness for the LLM loop. Handles tool execution (bash, filesystem, email) and conversation management. |
| LLM | **Claude Opus 4.6** (`claude-opus-4-6`) | Most capable model for complex multi-turn coordination, nuanced communication, and structured decision-making. |
| Email | **agentmail** | Programmatic email addresses, webhook inbound |
| Agent filesystem | `/agents/{agent_id}/` on host | No sandbox. Convention-based isolation. Memory + facts files. |
| Deployment | Single VM (fly.io or Railway) | MVP simplicity |
| Observability | Temporal UI + structured logging | Free workflow visibility |

---

## Data Model (SQLite)

```sql
CREATE TABLE agents (
    agent_id        TEXT PRIMARY KEY,           -- e.g. "dinner-7f3a"
    agent_email     TEXT UNIQUE NOT NULL,       -- provisioned agentmail address
    owner_email     TEXT NOT NULL,              -- owner's personal email
    objective       TEXT NOT NULL,              -- original free-text prompt

    -- The three pillars (generated during creation wizard)
    soul            TEXT NOT NULL,              -- personality, voice, style
    boundaries      TEXT NOT NULL,              -- constraints, escalation rules, info limits
    tools           TEXT NOT NULL,              -- natural language description of capabilities

    -- Runtime
    status          TEXT NOT NULL DEFAULT 'CREATED',  -- CREATED/RUNNING/SLEEPING/ESCALATED/COMPLETED/FAILED
    temporal_run_id TEXT NOT NULL,
    max_turns       INTEGER NOT NULL DEFAULT 20,
    timeout_hours   INTEGER NOT NULL DEFAULT 72,

    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT
);
```

```sql
CREATE TABLE conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
    role        TEXT NOT NULL,              -- "user", "assistant", "system"
    message     TEXT NOT NULL,              -- JSON-serialized LLM message
    timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_conversations_agent ON conversations(agent_id, id);
```

**Two tables, clear responsibilities:**
- `agents` — the agent's identity (SOUL/BOUNDARIES/TOOLS) and lifecycle state. Set at creation, read every turn.
- `conversations` — the agent's full LLM conversation history. Append-only. One row per message. Reconstruct the full conversation with `SELECT * FROM conversations WHERE agent_id = ? ORDER BY id`.

---

## API Surface (Next.js API Routes)

```
# Agent creation wizard
POST   /api/agents/prepare         → Generate clarifying questions from objective
POST   /api/agents/generate        → Generate SOUL/BOUNDARIES/TOOLS from objective + answers

# Agent CRUD
POST   /api/agents                 → Create agent (writes DB, provisions email, starts workflow)
GET    /api/agents                 → List all agents
GET    /api/agents/:id             → Agent detail + conversation history
PUT    /api/agents/:id             → Update agent (edit SOUL/BOUNDARIES/TOOLS)
DELETE /api/agents/:id             → Cancel agent (terminate workflow, send apology emails)

# Signals
POST   /api/agents/:id/signal      → Send manual signal (owner nudge)

# Webhooks
POST   /api/webhooks/inbound-email → agentmail webhook (routes to Temporal signal)
```

---

## Failure Modes & Mitigations

| Failure | Mitigation |
|---------|------------|
| LLM returns invalid JSON | Retry with stricter prompt. After 3 failures → FAILED. |
| Email delivery fails | Temporal retry policy (3x exponential). After exhaustion → escalate to owner. |
| Agent loops without progress | Max turn count (default 20). On exceed → escalate, then fail. |
| Participant never replies | 2 nudges max, then agent proceeds without them or escalates. |
| Agent lifetime exceeded | Hard timeout (default 72h). Workflow cancelled, owner notified. |
| Temporal worker crashes | Temporal replays workflow from event history. No state lost. |

---

## Security & Trust

- Agents never claim to be human unless the SOUL explicitly says so. Default: "Hi, I'm an assistant helping the owner coordinate X."
- Agent emails include a footer: "This is an automated message from [agent.mail]. Reply to this email to respond."
- Owner can cancel any agent at any time (DELETE /agents/:id sends apology emails, terminates workflow).
- **No sandbox (V1).** Agents run unsandboxed. The owner only deploys agents for people they know and trust. This is a deliberate simplicity tradeoff — sandboxing is a V2 concern.
- **BOUNDARIES as the safety layer.** The BOUNDARIES field in the system prompt is the primary constraint mechanism. It's soft enforcement (LLM-based), which is fine for V1 since the owner controls the participant list.
- **Conversation table as audit trail.** Every LLM message (user wake triggers, assistant responses, tool calls, tool results) is persisted in the `conversations` table. Full replay of any agent's history with a single query.

---

## MVP Scope (Week 1-2)

**MVP goal: CRUD agents and the creation wizard must work end-to-end.**

Build the thinnest possible slice:

1. **Next.js app** — creation wizard (prompt → questions → SOUL/BOUNDARIES/TOOLS review → launch) + agent list (CRUD) + agent detail page
2. **Prisma + SQLite** — `agents` table (SOUL/BOUNDARIES/TOOLS, objective, status, participants, etc.) + `conversations` table. Full CRUD: create, read, update, delete agents.
3. **Agent creation flow (must work):**
   - `POST /api/agents/prepare` — takes objective, returns LLM-generated clarifying questions
   - `POST /api/agents/generate` — takes objective + answers, returns generated SOUL/BOUNDARIES/TOOLS
   - `POST /api/agents` — writes to DB, provisions agentmail address, starts Temporal workflow
   - `GET /api/agents` — list all agents
   - `GET /api/agents/:id` — agent detail + conversation history
   - `PUT /api/agents/:id` — edit SOUL/BOUNDARIES/TOOLS
   - `DELETE /api/agents/:id` — cancel agent, terminate workflow
4. **Temporal Workflow** — state machine loop, hydrates from DB via Prisma, three signal types
5. **Pi agent** — agent harness for the LLM loop (Opus 4.6). Manages tool execution (bash, filesystem, email), conversation turn management.
6. **Email Gateway** — agentmail provisioning + inbound webhook → routes to correct Temporal signal (email vs. owner)
7. **send_email Activity** — agentmail SDK

### What "working" means for MVP
- You can open the web UI, go through the creation wizard, and see a new agent in the DB with SOUL/BOUNDARIES/TOOLS populated
- You can list, view, edit, and delete agents from the UI
- The agent's first turn fires (sends initial emails to participants)
- Conversation messages are persisted in the `conversations` table

### Out of scope for MVP
- Multi-channel (Slack, iMessage, SMS)
- Agent-to-agent communication
- PII post-filter (V2)
- Billing/rate limiting

---

## Agent Capabilities

Every agent ships with three capabilities, executed via Pi agent. No per-agent tool curation needed.

**1. Email (send/receive)**
The agent's primary communication channel. Send via agentmail SDK activity. Receive via inbound webhook → Temporal signal.

**2. Bash shell**
Run any command on the host, `cwd` set to `/agents/{agent_id}/`. No sandbox — full host access. The agent can `curl` APIs, run Python scripts, parse data with `jq`, do math, whatever the task requires. The TOOLS field in the DB describes (in natural language) what the agent should know it can do with the shell, and any API keys or credentials pre-loaded in its environment.

**3. Filesystem**
Read and write files in the agent's working directory. Used for `memory.md`, `facts.json`, scripts, data files, drafts, etc.

**Why this model?** Instead of building typed activities for every domain (calendar, restaurant booking, web search), the agent uses bash to compose any capability it needs. Need Google Calendar? `curl` with an OAuth token. Need to find a restaurant? `curl` the Yelp API. This means adding new "skills" is just a matter of providing API keys and updating the TOOLS description — no new code.

**Pi agent as the harness:** Pi agent manages the LLM conversation loop for each turn. It loads the conversation from the `conversations` table, builds the system prompt from SOUL/BOUNDARIES/TOOLS, calls Opus 4.6, executes tool calls (bash, file I/O, email), appends all messages back to the `conversations` table, and returns the decision to the Temporal workflow.

**Example TOOLS field for a dinner-planning agent:**
```
You have a bash shell and can run any command. Your working directory is /agents/dinner-7f3a/.

Available APIs (credentials pre-loaded as env vars):
- Google Calendar: use $GCAL_TOKEN to check availability and create events
- Yelp Fusion: use $YELP_API_KEY to search restaurants
- agentmail: email sending is handled by the send_email action (not bash)

You can write Python scripts, use curl, jq, or any standard CLI tool.
```

---

## PII Post-Filter (V2)

Before any outbound action (email send, calendar invite description, etc.), a post-filter layer inspects the content for PII leakage.

**Why:** The agent has access to the owner's calendar and email. The LLM might inadvertently include sensitive details from the owner's inbox (other meetings, private notes, health appointments) in outbound emails to participants.

**Design (V2):**
1. Every outbound action passes through a `pii_filter` activity before execution
2. The filter runs a separate, fast LLM call (Haiku) with a strict prompt: "Does this outbound message contain any information that was not explicitly part of the agent's objective or the participant's own replies?"
3. If flagged, the action is blocked and the agent escalates to the owner: "I was about to send this, but it may contain sensitive info. Should I proceed?"
4. Configurable sensitivity levels: strict (flag anything uncertain), permissive (only flag obvious PII)

**Out of scope for MVP** — in V1, agents can only send emails (no calendar/inbox reading), so the attack surface is small.

---

## Success Criteria

The MVP is working when:

1. You can create an agent through the web UI wizard — prompt, answer questions, review SOUL/BOUNDARIES/TOOLS, launch
2. The agent record (with SOUL, BOUNDARIES, TOOLS) is persisted in SQLite and hydrated by the Temporal workflow
3. The agent emails participants, collects replies over hours/days, and tracks state
4. The agent can run bash commands to accomplish sub-tasks (e.g. curl an API, run a script)
5. The agent escalates to the owner's personal email on conflicts, and resumes when the owner replies
6. The agent sends a completion summary when the objective is met
7. The whole thing survives a worker restart mid-conversation (Temporal replay)

---

## Open Questions

1. Should agents have memory across tasks? ("Last time we did dinner, Carol preferred Italian.")
2. What's the right model for agent personality — per-agent prompt, or a shared personality layer with per-task objective?
3. How do we handle email threading? (agentmail likely handles this via In-Reply-To headers, but need to verify.)
4. Should the owner be able to "fork" an agent mid-conversation? ("Actually, also plan a backup dinner for Saturday.")
5. Rate limiting: how many agents can one owner have active simultaneously?
