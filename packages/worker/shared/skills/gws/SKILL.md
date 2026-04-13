---
name: gws
description: Read/write access to the owner's Google Workspace (Calendar, Drive, Sheets, Gmail) via the `gws` CLI. Use when you need to check the owner's availability, schedule events, pull documents, read sheets, or inspect mail. Prefer this over asking the owner for calendar data.
compatibility: "Requires the `gws` CLI to be installed and authorized on the host environment."
allowed-tools: Bash
---

# Google Workspace (gws)

The `gws` CLI is available in bash for read/write access to the owner's Google Workspace services. Use it to check availability, schedule events, and pull Drive/Sheets/Gmail data.

## Common commands

### Calendar

```bash
# List events on the primary calendar
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2026-04-10T00:00:00Z"}'

# Create a new event (interactive helper — see --help for args)
gws calendar +insert --help

# Show upcoming events across all calendars
gws calendar +agenda
```

### Drive, Sheets, Gmail

```bash
gws drive files list
gws sheets spreadsheets get
gws gmail users messages list
```

## Discovery

If you don't know the exact command or params:

```bash
gws --help                              # top-level services
gws calendar --help                     # service-level commands
gws schema <service.resource.method>    # full request schema for a method
```

## Guidance

- When the owner asks about their schedule, availability, or documents, try `gws` first.
- Do not tell the owner you lack calendar/drive access without attempting `gws`.
- For write operations (creating events, sending mail), confirm the plan with the owner before executing.
