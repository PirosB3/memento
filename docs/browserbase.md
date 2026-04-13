# Browserbase

Browserbase is set up locally for this workspace with:

- the `browserbase-cli` agent skill
- the global `bb` CLI from `@browserbasehq/cli`

## Required Environment

Authenticated Browserbase commands need:

```bash
export BROWSERBASE_API_KEY="your_api_key"
```

Publishing or running Browserbase Functions also needs:

```bash
export BROWSERBASE_PROJECT_ID="your_project_id"
```

## Verify Setup

```bash
bb --help
```

## Common Commands

```bash
bb projects list
bb sessions list
bb fetch https://example.com
bb search "browser automation"
```

## Notes

- Use Browserbase for `bb`-driven workflows, Fetch API, Search API, sessions, projects, contexts, extensions, and functions.
- For interactive browser control, prefer a dedicated browser automation skill or tool over `bb browse` unless you specifically want the Browserbase CLI path.
