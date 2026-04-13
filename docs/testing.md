# Testing

## Local Commands
- `pnpm test:unit` runs fast unit coverage for pure logic and mocked boundaries.
- `pnpm test:integration` runs server/service integration tests with mocked external APIs.
- `pnpm test:workflow` runs Temporal workflow tests.
- `pnpm test:e2e` runs Playwright end-to-end coverage against fake AgentMail/Claude services.
- `pnpm test:smoke` runs the fast local confidence pass for common feature work.

## Feature Rule
- New pure logic must add or update a unit test.
- New server-side behavior must add or update an integration test.
- Workflow lifecycle changes must add or update a workflow test.
- User-facing flow changes must add or update a Playwright test and a manual smoke scenario.

## Mocking Policy
- AgentMail and Claude/Anthropic should be mocked by default in automated tests.
- Use `SUMMON_FAKE_EXTERNALS=1` for local browser smoke/E2E flows.
- Use injected service dependencies in server-side tests instead of live credentials.

## Manual Workflow
1. Implement the feature.
2. Run the narrowest relevant automated test command.
3. Run `pnpm test:smoke` before handing the feature off.
4. For UI changes, also run the matching manual smoke scenario in `test/manual/`.

## Browserbase
- Browserbase CLI setup notes live in [browserbase.md](./browserbase.md).
- Browserbase commands require `BROWSERBASE_API_KEY`.
- Browserbase Functions workflows also require `BROWSERBASE_PROJECT_ID`.
