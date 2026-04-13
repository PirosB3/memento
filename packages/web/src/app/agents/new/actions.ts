"use server";

import { revalidatePath } from "next/cache";
import {
  createAgent,
  generateAgentConfig,
  prepareAgent,
} from "@/lib/server/agent-services";

export interface PrepareAgentActionState {
  ok: boolean;
  error: string | null;
  questions: string[];
}

export interface GenerateAgentActionState {
  ok: boolean;
  error: string | null;
  result: {
    name: string;
    soul: string;
    boundaries: string;
    tools: string;
  } | null;
}

export interface CreateAgentActionState {
  ok: boolean;
  error: string | null;
  agent: {
    agentId: string;
    agentEmail: string;
    status: string;
  } | null;
}

export async function prepareAgentAction(
  _prevState: PrepareAgentActionState,
  formData: FormData,
): Promise<PrepareAgentActionState> {
  try {
    const result = await prepareAgent({
      objective: String(formData.get("description") ?? ""),
      ownerEmail: String(formData.get("ownerEmail") ?? ""),
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

export async function generateAgentConfigAction(
  _prevState: GenerateAgentActionState,
  formData: FormData,
): Promise<GenerateAgentActionState> {
  try {
    const answersRaw = String(formData.get("answersJson") ?? "{}");
    const result = await generateAgentConfig({
      objective: String(formData.get("description") ?? ""),
      ownerEmail: String(formData.get("ownerEmail") ?? ""),
      answers: JSON.parse(answersRaw) as Record<string, string>,
    });

    return {
      ok: true,
      error: null,
      result,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to generate config",
      result: null,
    };
  }
}

export async function createAgentAction(
  _prevState: CreateAgentActionState,
  formData: FormData,
): Promise<CreateAgentActionState> {
  try {
    const agent = await createAgent({
      ownerEmail: String(formData.get("ownerEmail") ?? ""),
      name: String(formData.get("name") ?? ""),
      soul: String(formData.get("soul") ?? ""),
      boundaries: String(formData.get("boundaries") ?? ""),
      tools: String(formData.get("tools") ?? ""),
    });

    revalidatePath("/agents");

    return {
      ok: true,
      error: null,
      agent: {
        agentId: agent.agentId,
        agentEmail: agent.agentEmail,
        status: agent.status,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to create agent",
      agent: null,
    };
  }
}
