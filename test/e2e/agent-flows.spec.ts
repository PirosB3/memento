import { expect, test } from "@playwright/test";

test("agent creation, task launch, and task kill flow @smoke", async ({ page }) => {
  const uniqueSuffix = Date.now();
  const taskObjectiveInput = page.getByPlaceholder(
    "Schedule dinner with alice@email.com for next Friday...",
  );

  await page.goto("/agents/new");

  await page.locator('textarea[name="description"]').fill(`A helpful coordinator ${uniqueSuffix}`);
  await page.locator('input[name="ownerEmail"]').fill(`owner-${uniqueSuffix}@example.com`);
  await page.getByRole("button", { name: /^Next$/ }).click();

  await expect(
    page.getByText("Answer these questions to help configure your agent's personality:"),
  ).toBeVisible();

  const wizardInputs = page.locator('input[type="text"]');
  const questionCount = await wizardInputs.count();
  for (let index = 0; index < questionCount; index++) {
    await wizardInputs.nth(index).fill(`Answer ${index + 1}`);
  }

  await page.getByRole("button", { name: /^Next$/ }).click();
  await expect(page.getByText("Review and edit your agent's configuration:")).toBeVisible();
  await page.getByRole("button", { name: "Create Agent" }).click();

  await expect(page.getByRole("heading", { name: "Agent Created" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Dashboard" }).click();

  await expect(page.getByText("Root Agent")).toBeVisible();

  await taskObjectiveInput.fill(`Follow up with Alice ${uniqueSuffix}`);
  await taskObjectiveInput
    .locator("..")
    .getByRole("button", { name: /^Next$/ })
    .click();
  await expect(page.getByText("Clarify a few things to help the agent:")).toBeVisible();

  const taskInputs = page.locator('input[type="text"]');
  const taskQuestionCount = await taskInputs.count();
  for (let index = 0; index < taskQuestionCount; index++) {
    await taskInputs.nth(index).fill(`Task answer ${index + 1}`);
  }

  await page.getByRole("button", { name: "Launch Task" }).click();
  await expect(page.getByText(`Follow up with Alice ${uniqueSuffix}`)).toBeVisible();

  const taskPanel = page.locator("details").filter({
    hasText: `Follow up with Alice ${uniqueSuffix}`,
  });

  page.once("dialog", (dialog) => dialog.accept());
  await taskPanel.getByRole("button", { name: "Kill" }).click();

  await expect(taskPanel).toContainText("COMPLETED");
});
