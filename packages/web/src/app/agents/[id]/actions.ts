"use server";

import { revalidatePath } from "next/cache";
import { createTask, prepareTask, restartTask, stopTask } from "@/lib/server/task-services";
import { restartAgentWorkflows, stopAgentWorkflows } from "@/lib/server/workflow-control";

export interface PrepareTaskActionState {
  ok: boolean;
  error: string | null;
  questions: string[];
}

export interface CreateTaskActionState {
  ok: boolean;
  error: string | null;
}

export async function prepareTaskAction(
  agentId: string,
  _prevState: PrepareTaskActionState,
  formData: FormData,
): Promise<PrepareTaskActionState> {
  try {
    const result = await prepareTask({
      agentId,
      objective: String(formData.get("objective") ?? ""),
    });

    return {
      ok: true,
      error: null,
      questions: result.questions,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to generate questions",
      questions: [],
    };
  }
}

export async function createTaskAction(
  agentId: string,
  _prevState: CreateTaskActionState,
  formData: FormData,
): Promise<CreateTaskActionState> {
  try {
    const answersRaw = String(formData.get("answersJson") ?? "{}");
    await createTask({
      agentId,
      objective: String(formData.get("objective") ?? ""),
      answers: JSON.parse(answersRaw) as Record<string, string>,
    });

    revalidatePath(`/agents/${agentId}`);
    revalidatePath("/agents");

    return {
      ok: true,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to create task",
    };
  }
}

export async function stopTaskAction(agentId: string, taskId: string): Promise<void> {
  await stopTask(agentId, taskId);
  revalidatePath(`/agents/${agentId}`);
  revalidatePath(`/agents/${agentId}/tasks/${taskId}`);
  revalidatePath("/agents");
}

export async function restartTaskAction(agentId: string, taskId: string): Promise<void> {
  await restartTask(agentId, taskId);
  revalidatePath(`/agents/${agentId}`);
  revalidatePath(`/agents/${agentId}/tasks/${taskId}`);
  revalidatePath("/agents");
}

export async function stopAgentAction(agentId: string): Promise<void> {
  await stopAgentWorkflows(agentId);
  revalidatePath(`/agents/${agentId}`);
  revalidatePath("/agents");
}

export async function restartAgentAction(agentId: string): Promise<void> {
  await restartAgentWorkflows(agentId);
  revalidatePath(`/agents/${agentId}`);
  revalidatePath("/agents");
}
