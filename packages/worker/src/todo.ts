import fs from "fs";

export const TODO_SLEEP_REJECTION_MESSAGE =
  "There is still something actionable in your list. Please address it or update the to-do list.";

export const TODO_AUTO_DEFER_MESSAGE =
  "Auto-deferred after three sleep attempts in the same turn to prevent an infinite decision loop.";

export interface TodoSnapshotState {
  snapshot: string | null;
  actionableItems: string[];
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

    if (currentSection === "ACTIONABLE" && trimmed.startsWith("- ")) {
      actionableItems.push(trimmed.slice(2).trim());
    }
  }

  return {
    snapshot,
    actionableItems,
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
      isValid: false,
    };
  }
}
