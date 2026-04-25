import fs from "fs";

export const TODO_SLEEP_REJECTION_MESSAGE =
  "There is still something actionable in your list. Please address it or update the to-do list.";

export const TODO_AUTO_DEFER_MESSAGE =
  "Auto-deferred after three sleep attempts in the same turn to prevent an infinite decision loop.";

export const DONE_RECENT_CAP = 5;

export interface TodoSnapshotState {
  snapshot: string | null;
  actionableItems: string[];
  blockedItems: string[];
  doneItems: string[];
  isValid: boolean;
}

export function buildMissingTodoNotice(todoRelativePath: string): string {
  return `TODO file missing. Create ${todoRelativePath} and populate [ACTIONABLE], [BLOCKED], and [DONE] before ending this turn.`;
}

export function buildInvalidTodoNotice(todoRelativePath: string): string {
  return `TODO file is malformed. Update ${todoRelativePath} so it contains [ACTIONABLE], [BLOCKED], and [DONE] sections before ending this turn.`;
}

export function parseTodoSnapshot(snapshot: string): TodoSnapshotState {
  const actionableItems: string[] = [];
  const blockedItems: string[] = [];
  const doneItems: string[] = [];
  let currentSection: "ACTIONABLE" | "BLOCKED" | "DONE" | null = null;
  let sawActionableSection = false;
  let sawBlockedSection = false;
  let sawDoneSection = false;

  for (const line of snapshot.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed === "[ACTIONABLE]") {
      currentSection = "ACTIONABLE";
      sawActionableSection = true;
      continue;
    }

    if (trimmed === "[BLOCKED]") {
      currentSection = "BLOCKED";
      sawBlockedSection = true;
      continue;
    }

    if (trimmed === "[DONE]") {
      currentSection = "DONE";
      sawDoneSection = true;
      continue;
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      currentSection = null;
      continue;
    }

    if (!trimmed.startsWith("- ")) continue;
    const itemText = trimmed.slice(2).trim();

    if (currentSection === "ACTIONABLE") actionableItems.push(itemText);
    else if (currentSection === "BLOCKED") blockedItems.push(itemText);
    else if (currentSection === "DONE") doneItems.push(itemText);
  }

  return {
    snapshot,
    actionableItems,
    blockedItems,
    doneItems,
    isValid: sawActionableSection && sawBlockedSection && sawDoneSection,
  };
}

export function readTodoSnapshot(todoPath: string): TodoSnapshotState {
  try {
    const snapshot = fs.readFileSync(todoPath, "utf-8");
    return parseTodoSnapshot(snapshot);
  } catch {
    return {
      snapshot: null,
      actionableItems: [],
      blockedItems: [],
      doneItems: [],
      isValid: false,
    };
  }
}

function renderTodoItems(items: string[]): string {
  return items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");
}

/**
 * Rebuild the todo snapshot for prompt injection, capping the [DONE] section to the
 * most recent `cap` entries. The full file is still on disk for the agent to read on
 * demand. Returns the original snapshot unchanged when [DONE] is already small enough.
 */
export function buildCappedTodoSnapshot(
  state: TodoSnapshotState,
  cap = DONE_RECENT_CAP,
): string {
  if (state.snapshot === null) return "";
  if (state.doneItems.length <= cap) return state.snapshot;

  const dropped = state.doneItems.length - cap;
  const recentDone = state.doneItems.slice(-cap);

  return [
    "# TODO",
    "",
    "[ACTIONABLE]",
    renderTodoItems(state.actionableItems),
    "",
    "[BLOCKED]",
    renderTodoItems(state.blockedItems),
    "",
    "[DONE]",
    `- (... ${dropped} earlier item(s) omitted; full history on disk)`,
    ...recentDone.map((item) => `- ${item}`),
  ].join("\n");
}
