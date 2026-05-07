"use client";

import { useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Step = "closed" | "objective" | "questions";

type CreatedTaskResponse = {
  taskId: string;
};

export default function ControlPlaneNewTaskForm({
  agentId,
  disabled,
  onCreated,
}: {
  agentId: string;
  disabled?: boolean;
  onCreated?: (taskId: string) => void;
}) {
  const [step, setStep] = useState<Step>("closed");
  const [objective, setObjective] = useState("");
  const [seedThreadId, setSeedThreadId] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function resetForm(nextStep: Step = "closed") {
    setStep(nextStep);
    setObjective("");
    setSeedThreadId("");
    setQuestions([]);
    setAnswers({});
    setError(null);
    setPending(false);
  }

  async function prepareQuestions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = objective.trim();
    if (!trimmed) return;

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${agentId}/tasks/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: trimmed }),
      });

      const body = await response.json().catch(() => null) as { questions?: string[]; error?: string } | null;
      if (!response.ok || !body?.questions) {
        setError(body?.error ?? "Failed to generate questions.");
        return;
      }

      setObjective(trimmed);
      setQuestions(body.questions);
      setAnswers(Object.fromEntries(body.questions.map((question) => [question, ""])));
      setStep("questions");
    } catch {
      setError("Failed to generate questions.");
    } finally {
      setPending(false);
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${agentId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objective,
          answers,
          seedThreadId: seedThreadId.trim() || undefined,
        }),
      });

      const body = await response.json().catch(() => null) as (CreatedTaskResponse & { error?: string }) | null;
      if (!response.ok || !body?.taskId) {
        setError(body?.error ?? "Failed to create task.");
        return;
      }

      resetForm();
      onCreated?.(body.taskId);
    } catch {
      setError("Failed to create task.");
    } finally {
      setPending(false);
    }
  }

  if (step === "closed") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-start"
        disabled={disabled}
        onClick={() => setStep("objective")}
      >
        <Plus data-icon="inline-start" />
        New task
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-xs font-medium text-foreground">New task</div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={() => resetForm()}
          aria-label="Close new task form"
        >
          <X />
        </Button>
      </div>

      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}

      {step === "objective" && (
        <form onSubmit={prepareQuestions} className="flex flex-col gap-2">
          <input
            type="text"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="What should this agent handle?"
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
          />
          <Button type="submit" size="sm" disabled={!objective.trim() || pending}>
            {pending ? "Preparing..." : "Next"}
          </Button>
        </form>
      )}

      {step === "questions" && (
        <form onSubmit={createTask} className="flex flex-col gap-3">
          <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Task:</span> {objective}
          </div>
          {questions.map((question, index) => (
            <label key={question} className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>{question}</span>
              <input
                type="text"
                value={answers[question] ?? ""}
                onChange={(event) => {
                  setAnswers((current) => ({ ...current, [question]: event.target.value }));
                }}
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none transition-colors focus:border-ring"
                aria-label={`Answer ${index + 1}`}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Thread slug (advanced — leave blank to auto-generate)</span>
            <input
              type="text"
              value={seedThreadId}
              onChange={(event) => setSeedThreadId(event.target.value)}
              placeholder="e.g. union-market-cart-2026-04-25"
              className="h-8 rounded-lg border border-input bg-background px-2 font-mono text-sm text-foreground outline-none transition-colors focus:border-ring"
              aria-label="Optional thread slug"
            />
          </label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => resetForm()}>
              Cancel
            </Button>
            <Button type="submit" size="sm" className="flex-1" disabled={pending}>
              {pending ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
