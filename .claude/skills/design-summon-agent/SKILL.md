---
name: design-summon-agent
description: Use when Daniel wants to brainstorm, design, or decide on a new Memento/Summon agent (a Lou/Nina/Emma-style persistent identity). Triggers on phrases like "what new agent should I build", "design a new agent", "let's brainstorm an agent for X", "what other workflows could we test", or any open-ended request to identify the next agent worth standing up. NOT for the mechanics of spinning one up after the design is decided — that's a different problem.
---

# Designing a new Summon agent

Daniel built Memento (the Summon platform). He has a lot of ideas. The bottleneck isn't building — it's deciding *which* agent is actually worth Daniel's attention next. Bad agent ideas are easy to generate and feel productive; good ones come from evidence in his actual inbox, calendar, and existing agent state.

This skill captures the methodology. Follow it end-to-end. **Do not freelance** — the discipline is the value.

## Hard rules — read first

1. **You MUST ask Daniel 5–10 questions via `AskUserQuestion` across the session.** This is non-negotiable. Tool max is 4 questions per call, so plan on 2–3 batches. Questions calibrate scope, then narrow the design space, then confirm the final pick. Do not skip this — recommendations made without questions are guesses.
2. **You MUST gather real evidence before recommending.** That means actual queries against Gmail, Google Calendar, and the macstudio Memento DB. Recommendations off your priors are worthless to him.
3. **Do not propose generic AI assistants.** Every agent must have a concrete domain, concrete counterparties, and concrete evidence of pain.
4. **Narrow ruthlessly.** End with 1–3 recommendations with one-line tradeoffs. Five+ ideas force Daniel to do the narrowing work himself, which defeats the point.
5. **The act of *creating* the agent is out of scope for this skill.** Stop once Daniel has confirmed the pick and you've drafted the SOUL/BOUNDARIES/TOOLS. Hand off creation to a separate flow.

## Phase 0 — Orient

Before anything else, know what already exists. Read the existing agents in the Memento DB on macstudio:

```bash
PGPASSWORD=summon psql -h macstudio -U summon -d summon_dev \
  -c "SELECT agent_id, name, agent_email, status, LEFT(soul, 200) as soul FROM agents ORDER BY created_at;"
```

Then list active tasks per agent and message volume:

```bash
PGPASSWORD=summon psql -h macstudio -U summon -d summon_dev \
  -c "SELECT t.task_id, t.agent_id, t.tag, t.is_root, t.status, LEFT(t.objective, 120) as obj, t.last_activity_at FROM tasks t ORDER BY t.created_at;"

PGPASSWORD=summon psql -h macstudio -U summon -d summon_dev \
  -c "SELECT task_id, COUNT(*) as n FROM conversations GROUP BY task_id ORDER BY n DESC LIMIT 10;"
```

You're looking for:
- **What domains are already covered?** (Lou owns household; Nina owns recruiting; Emma owns infra-bills)
- **What patterns dominate?** (long-horizon child tasks vs short one-shots; multi-party coord vs solo)
- **Which agents see the most traffic?** (proxy for value)
- **What gaps are obvious from the SOUL/BOUNDARIES texts?** (e.g., Nina explicitly recruiter-only → personal scheduling is gapped)

Don't tell Daniel about this orientation — just have it loaded before you ask him anything.

## Phase 1 — Calibrate the design space (questions 1–4)

Ask Daniel 4 questions in a single `AskUserQuestion` call to narrow the space cheaply *before* committing to deep evidence work. Use these dimensions:

1. **Lane**: Personal/household (Lou-line) | Professional (Nina-line) | New domain entirely
2. **Primitive emphasis**: Browser site automation | Multi-party email coord | Both | Long-horizon memory/state
3. **Trigger**: Event-driven inbound email | Recurring schedule | Owner-initiated only | Mix
4. **Risk gate**: Has approval gate (irreversible action behind owner CONFIRM) | Read-only/advisory | Autonomous within tight bounds

These four are mutually orthogonal and they prune the candidate space to ~40% in one shot.

## Phase 2 — Deep evidence dive

This is the most important phase. **Run these in parallel.** Daniel granted access to his Gmail, Google Calendar, and macstudio DB — use all three. The goal is to find *visceral, dated, named* pain — not generic patterns.

### Gmail searches that consistently surface friction

Run these in parallel via `mcp__claude_ai_Gmail__gmail_search_messages`. Tune queries to recent windows (last 30–60 days) and exclude `category:promotions` to avoid noise.

| Pattern | Query | What it surfaces |
|---|---|---|
| Billing volume | `subject:(receipt OR invoice OR payment OR renewal OR subscription) after:2026/X/Y` | Subscription/infra spend, vendor sprawl |
| Action items | `subject:(reminder OR overdue OR "action required" OR confirm) after:2026/X/Y` | Things Daniel is sitting on |
| Scheduling churn | `(reschedule OR availability OR "let me know" OR "works for you" OR "does that work") after:2026/X/Y -from:noreply` | Meeting back-and-forth pain |
| Daniel's own load | `from:me after:2026/X/Y -from:noreply` | What Daniel is manually doing — high signal for "what could be delegated" |
| Family/medical | `(pediatric OR pediatrician OR vaccine OR doctor OR appointment OR daycare OR Luca OR insurance) -category:promotions` | Family logistics |
| Business admin | `(acilia OR LLC OR "business address" OR stripe OR domain OR workspace) -category:promotions` | Side-business hygiene |
| Vendor-specific | `from:(@cloudflare OR @vercel OR @digitalocean OR @browserbase OR invoice+statements@)` | Per-vendor billing for ledger seeding |

### Calendar dive

Use `mcp__claude_ai_Google_Calendar__list_events` for the last 30–60 days. The output is large — if it exceeds the token cap, the tool writes to a file you can `jq` over. Useful one-liner once written to disk:

```bash
jq -r '.events[] | "\(.start.dateTime // .start.date) | \(.summary // "no-title") | \(.attendees // [] | length) attendees"' <file>
```

**The calendar-as-todo heuristic** is the highest-signal pattern in Daniel's calendar specifically. Look for events with **0 attendees and verb-form titles**:
- *"Pay daycare + extend taxes"*
- *"Reach out to Sal"*
- *"Re-enable the server for Spark of Genius"*
- *"🔑 Reminder: Wells Fargo safe deposit box — plan SF trip before May 29"*

These are tasks Daniel has externalized to his calendar because no system is doing them for him. Each cluster (e.g., "Sal the contractor", "trip prep", "tax/finance admin") is a candidate agent.

### Smoking-gun heuristic — search Daniel's sent mail

The strongest possible signal is Daniel **force-fitting an existing agent for an out-of-scope job**. This is exactly how Emma was discovered: Daniel emailed Nina (recruiter agent) at 11:00 AM asking her to schedule a personal training session. Nina pushed back; the gap was undeniable.

Look for sent emails to `lou-2@agentmail.to`, `nina-2@agentmail.to`, `emma-2@agentmail.to` (and any future agent addresses) where the request falls outside that agent's stated scope. If you find one, lead with it. It's evidence that no further questioning can manufacture.

### Other patterns worth looking for

- **Inbox decay**: repeat unread threads from the same sender (patient portals, vendor support)
- **Long thread chains** (`>5` messages) on scheduling
- **Bleeding**: failed payments, "action required" emails ignored for >7 days
- **Recurring manual sends**: same kind of email Daniel sends N times across months

## Phase 3 — Brainstorm wide, then narrow

Generate ~5–10 candidate agents *silently* (do not present this list). For each, score on three axes:

| Axis | What to assess |
|---|---|
| Visceral pain | Today-pain (someone is waiting / something is bleeding) > chronic background tax > theoretical pain |
| Reuse | Pure reuse of existing tooling (gws + Browserbase + email) > one new skill needed > new integration required |
| Fit with Phase 1 answers | Matches Daniel's stated lane / primitive / trigger / risk preferences |

Filter to **top 3** by combined score. Each gets:
- A name (matching the Lou/Nina/Emma vibe — short, character-y first names)
- A one-line description of what it owns
- The concrete pieces of evidence you found that justify it
- The main tradeoff (what makes it harder than alternatives)

## Phase 4 — Refinement questions (questions 5–7)

Before recommending, ask Daniel another 2–3 `AskUserQuestion` to refine:

- **Time horizon**: Start today (reuse only) | This week (one new skill OK) | Multi-week (new integration OK)
- **Counterparties**: which real-world parties are realistically in scope right now (multi-select)
- **Sandbox tolerance**: Real accounts/real money | Real accounts/no irreversible spend | Stub only

These shape *which* of your top 3 to recommend starting *first*.

## Phase 5 — Recommend

Present **top 3** with the structure that worked for Emma:
1. Name + one-sentence purpose
2. Why now — the specific evidence (quote the smoking-gun email, name the calendar todo)
3. How it works — triggers, primitives used, multi-party shape, approval gate
4. Why this fits Daniel's stated answers
5. Time-to-start (today / this week / next)

Then close with a **single recommendation for what to start first** (or two, if they're naturally paired). Do not punt the narrowing back to him.

## Phase 6 — Categorize the chosen agent

Once Daniel picks the agent to build, before drafting SOUL/BOUNDARIES/TOOLS, force these categorizations explicitly:

### Root vs child task — KEY DECISION
- **Child task** of an existing agent: inherits the parent's agentmail address and **email view is filtered to threads involving the child's `+tag` address**. Cannot see unrelated inbox content.
- **New root agent**: fresh agentmail address, **unfiltered inbox via `read_emails`**, can scan everything.
- **Rule**: if the agent needs broad inbox visibility (e.g., scanning all billing emails), it MUST be a new root agent. If it's scoped to a single objective with a finite participant set, it can be a child task of an existing agent (or a child of a new root).
- Identity also matters: child tasks email *as* their parent. Mixing distinct personas under one parent muddies both.

### Other categorizations
- **Lou-line vs Nina-line vs new domain** — affects soul register and tone
- **Single-party (owner only) vs multi-party (vendors/recruiters)** — affects boundary discipline
- **Trigger model** — event / scheduled / owner / mix
- **Approval gate** — where the irreversible-action wall lives, with what token format
- **Time horizon** — one-shot, weekly recurring, indefinite

## Phase 7 — Draft SOUL / BOUNDARIES / TOOLS

Use the structure that's now battle-tested across Lou, Nina, and Emma. **Always include**:

### SOUL
- 3–5 sentences. Persona + voice + decision style.
- Match register to domain (Lou: warm family member; Nina: efficient recruiter coordinator; Emma: meticulous accountant).
- State plainly how it should write (no fluff, no emoji, sign as "Name").

### BOUNDARIES — sectioned, not prose
- **READ SCOPE**: which inboxes / data sources, which keyword filters
- **OUT OF SCOPE — do not touch**: explicit list. *"This is Lou's territory. Don't act on grocery threads."* Prevents agent sprawl conflicts.
- **HARD APPROVAL GATE**: exact token format (e.g., `CONFIRM <vendor> <action>`). No interpretation, no "I think you meant".
- **AUTO-OK**: reversible actions the agent can take without asking
- **ESCALATE**: ambiguity, surprises, novel vendors/parties, anything > X% change
- **NEVER**: identity/security/credential rules
- **COMMUNICATION**: who to CC, signature, tone reminders

### TOOLS
- Enumerate tool families with one line each: AgentMail, gws CLI for real-inbox access, Browserbase (`bb` + `browse`), bash, files, scheduling, decide
- Include a **FIRST-TURN BEHAVIOR** numbered list — what bootstrap actions the agent should take on its very first turn (e.g., "scan last 90 days of receipts to seed vendors.md")

## Phase 8 — Final confirmation (questions 8–10)

Before stopping, confirm via `AskUserQuestion`:

- **Name lock-in** (3 options + "Other" auto-provided)
- **Scope confirmation** — "anything I missed in OUT OF SCOPE that should be added?"
- **Creation path** — "want me to create this now, or save the draft for later?"

If creation is requested, hand off — that's a different skill / flow. The Emma session is the precedent for how to do it via direct DB + Temporal when the web wizard isn't reachable.

## Anti-patterns to avoid

| Anti-pattern | Why it fails |
|---|---|
| Recommending without inbox/calendar evidence | Recommendations off priors are guesses; Daniel can spot it |
| Generic "AI personal assistant" agents | Every successful agent has a single concrete domain |
| Asking >4 questions in one batch | Tool refuses; user gets fatigued |
| Asking <5 questions across the session | Insufficient calibration; recommendations don't match Daniel's situation |
| Presenting >3 final recommendations | Pushes narrowing work back onto him |
| Skipping Phase 6 (root vs child) | Child tasks can't see unfiltered inbox — easy to design something that won't work |
| Writing prose-style BOUNDARIES | Sections are scannable; prose isn't |
| Forgetting OUT OF SCOPE in BOUNDARIES | Causes conflicts when the agent later overlaps with Lou/Nina/Emma |
| Treating the act of creation as part of this skill | Different problem; different skill |

## Reference — what "good" looks like

The Emma session (April 2026) is the canonical example. Sequence:
1. Phase 0: read DB → discovered Lou (household/grocery) and Nina (recruiting) cover those lanes
2. Phase 1: 4 calibration questions → Daniel wanted both lanes, long-horizon + multi-party bias, mix triggers, approval gate
3. Phase 2: parallel Gmail + Calendar + DB queries → found 4 distinct candidate domains
4. Smoking gun: Daniel's 11:00 AM email to Nina asking her to schedule PT (out of scope) → proved the personal-ops gap
5. Calendar-as-todo: dozens of 0-attendee verb-titled events → proved unmet exec function
6. Phase 3: 5+ candidates silently → narrowed to top 3 (Mira / Atlas / Emma)
7. Phase 4: 3 refinement questions → Daniel said "subscription billers, real money, start now"
8. Phase 5: recommended Emma to start, with Mira/Atlas as next
9. Phase 6: categorized as new root (needs unfiltered inbox), Lou-line domain, multi-party with vendors, approval gate via `CONFIRM <vendor> <action>` token, indefinite horizon
10. Phase 7: drafted SOUL / sectioned BOUNDARIES / TOOLS with first-turn bootstrap
11. Phase 8: name lock-in (Atticus → Emma), scope confirmation, creation path → handed off

If a future session looks meaningfully different from this arc, something is being skipped.
