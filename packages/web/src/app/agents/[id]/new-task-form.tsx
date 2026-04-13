"use client";

import { useActionState, useEffect, useState } from "react";
import {
  createTaskAction,
  prepareTaskAction,
} from "./actions";
import type { CreateTaskActionState, PrepareTaskActionState } from "./actions";

type Step = "objective" | "questions" | "creating";

const initialPrepareTaskState: PrepareTaskActionState = {
  ok: false,
  error: null,
  questions: [],
};

const initialCreateTaskState: CreateTaskActionState = {
  ok: false,
  error: null,
};

export default function NewTaskForm({ agentId }: { agentId: string }) {
  const [step, setStep] = useState<Step>("objective");
  const [objective, setObjective] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const [prepareState, prepareFormAction, preparePending] = useActionState(
    prepareTaskAction.bind(null, agentId),
    initialPrepareTaskState,
  );
  const [createState, createFormAction, createPending] = useActionState(
    createTaskAction.bind(null, agentId),
    initialCreateTaskState,
  );

  useEffect(() => {
    if (prepareState.ok) {
      setQuestions(prepareState.questions);
      setAnswers(Object.fromEntries(prepareState.questions.map((question) => [question, ""])));
      setError(null);
      setStep("questions");
    } else if (prepareState.error) {
      setError(prepareState.error);
    }
  }, [prepareState]);

  useEffect(() => {
    if (createState.ok) {
      setObjective("");
      setQuestions([]);
      setAnswers({});
      setError(null);
      setStep("objective");
    } else if (createState.error) {
      setError(createState.error);
      setStep("questions");
    }
  }, [createState]);

  function handleCancel() {
    setStep("objective");
    setQuestions([]);
    setAnswers({});
    setError(null);
  }

  return (
    <div className="card p-4">
      <label htmlFor="new-task-objective" className="block text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
        New Task
      </label>
      {error && <div className="text-red-400 text-xs mb-2">{error}</div>}

      {step === "objective" && (
        <form action={prepareFormAction} className="flex gap-2">
          <input
            id="new-task-objective"
            name="objective"
            type="text"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Schedule dinner with alice@email.com for next Friday..."
            className="flex-1 border rounded-lg p-2 text-sm"
          />
          <button
            type="submit"
            disabled={!objective.trim() || preparePending}
            className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap transition-all"
          >
            {preparePending ? "Thinking..." : "Next"}
          </button>
        </form>
      )}

      {step === "questions" && (
        <form action={createFormAction} className="space-y-3">
          <input type="hidden" name="objective" value={objective} />
          <input type="hidden" name="answersJson" value={JSON.stringify(answers)} />
          <div className="text-sm text-[var(--muted-foreground)] card-inset rounded-lg p-2.5">
            <span className="font-medium text-[var(--foreground)]">Task:</span> {objective}
          </div>
          <p className="text-[10px] text-[var(--muted)]">Clarify a few things to help the agent:</p>
          {questions.map((q, i) => (
            <div key={i}>
              <label
                htmlFor={`task-question-${i}`}
                className="block text-xs font-medium text-[var(--muted-foreground)] mb-1"
              >
                {q}
              </label>
              <input
                id={`task-question-${i}`}
                type="text"
                value={answers[q] ?? ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q]: e.target.value }))}
                className="w-full border rounded-lg p-2 text-sm"
              />
            </div>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCancel}
              className="border border-[var(--card-border)] text-[var(--muted-foreground)] px-4 py-2 rounded-lg text-sm hover:bg-[rgba(255,255,255,0.04)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createPending}
              className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:brightness-110 disabled:opacity-40 transition-all"
            >
              {createPending ? "Creating..." : "Launch Task"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
