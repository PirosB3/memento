"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { controlPlanePath } from "@/lib/control-plane-paths";

import {
  createAgentAction,
  generateAgentConfigAction,
  prepareAgentAction,
} from "./actions";
import type {
  CreateAgentActionState,
  GenerateAgentActionState,
  PrepareAgentActionState,
} from "./actions";

type Step = "describe" | "questions" | "review" | "done";

interface AgentResult {
  agentId: string;
  agentEmail: string;
  status: string;
  profileImageUrl: string | null;
}

const initialPrepareAgentState: PrepareAgentActionState = {
  ok: false,
  error: null,
  questions: [],
};

const initialGenerateAgentState: GenerateAgentActionState = {
  ok: false,
  error: null,
  result: null,
};

const initialCreateAgentState: CreateAgentActionState = {
  ok: false,
  error: null,
  agent: null,
};

const steps: Step[] = ["describe", "questions", "review", "done"];

export default function NewAgentWizard() {
  const [step, setStep] = useState<Step>("describe");
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [soul, setSoul] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [tools, setTools] = useState("");
  const [signatureDescription, setSignatureDescription] = useState("");
  const [agent, setAgent] = useState<AgentResult | null>(null);

  const [prepareState, prepareFormAction, preparePending] = useActionState(
    prepareAgentAction,
    initialPrepareAgentState,
  );
  const [generateState, generateFormAction, generatePending] = useActionState(
    generateAgentConfigAction,
    initialGenerateAgentState,
  );
  const [createState, createFormAction, createPending] = useActionState(
    createAgentAction,
    initialCreateAgentState,
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
    if (generateState.ok && generateState.result) {
      setName(generateState.result.name ?? "");
      setSoul(generateState.result.soul);
      setBoundaries(generateState.result.boundaries);
      setTools(generateState.result.tools);
      setSignatureDescription(generateState.result.signatureDescription ?? "");
      setError(null);
      setStep("review");
    } else if (generateState.error) {
      setError(generateState.error);
    }
  }, [generateState]);

  useEffect(() => {
    if (createState.ok && createState.agent) {
      setAgent(createState.agent);
      setError(null);
      setStep("done");
    } else if (createState.error) {
      setError(createState.error);
    }
  }, [createState]);

  const currentStepIndex = steps.indexOf(step);

  return (
    <div className="max-w-xl mx-auto py-12 px-6">
      <h1 className="font-[family-name:var(--font-outfit)] text-2xl font-bold tracking-tight mb-8">
        Create New Agent
      </h1>

      {/* Progress bar */}
      <div className="flex gap-2 mb-8">
        {steps.map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
              i <= currentStepIndex ? "bg-[var(--accent)]" : "bg-[rgba(255,255,255,0.08)]"
            }`}
          />
        ))}
      </div>

      {error && (
        <div className="card-inset border-red-500/20 bg-red-500/5 px-4 py-3 rounded-lg mb-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {step === "describe" && (
        <form action={prepareFormAction} className="space-y-5">
          <div>
            <label htmlFor="agent-description" className="block text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
              Describe your agent
            </label>
            <textarea
              id="agent-description"
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="A friendly personal assistant who helps me coordinate events, manage schedules, and communicate with people on my behalf"
              className="w-full border rounded-lg p-3 h-32 resize-none text-sm"
            />
            <p className="text-[10px] text-[var(--muted)] mt-1.5">
              Describe the agent&apos;s role and personality. You&apos;ll assign tasks to it later.
            </p>
          </div>
          <div>
            <label htmlFor="agent-owner-email" className="block text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
              Your email (for escalations)
            </label>
            <input
              id="agent-owner-email"
              name="ownerEmail"
              type="email"
              value={ownerEmail}
              onChange={(event) => setOwnerEmail(event.target.value)}
              placeholder="you@example.com"
              className="w-full border rounded-lg p-3 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={!description || !ownerEmail || preparePending}
            className="bg-[var(--accent)] text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {preparePending ? "Generating questions..." : "Next"}
          </button>
        </form>
      )}

      {step === "questions" && (
        <form action={generateFormAction} className="space-y-5">
          <input type="hidden" name="description" value={description} />
          <input type="hidden" name="ownerEmail" value={ownerEmail} />
          <input type="hidden" name="answersJson" value={JSON.stringify(answers)} />
          <p className="text-sm text-[var(--muted-foreground)]">
            Answer these questions to help configure your agent&apos;s personality:
          </p>
          {questions.map((question) => (
            <div key={question}>
              <label
                htmlFor={`question-${question}`}
                className="block text-xs font-medium text-[var(--muted-foreground)] mb-1.5"
              >
                {question}
              </label>
              <input
                id={`question-${question}`}
                type="text"
                value={answers[question] ?? ""}
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [question]: event.target.value,
                  }))
                }
                className="w-full border rounded-lg p-3 text-sm"
              />
            </div>
          ))}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep("describe")}
              className="border border-[var(--card-border)] text-[var(--muted-foreground)] px-6 py-2.5 rounded-lg text-sm hover:bg-[rgba(255,255,255,0.04)] transition-colors"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={generatePending}
              className="bg-[var(--accent)] text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:brightness-110 disabled:opacity-40 transition-all"
            >
              {generatePending ? "Generating config..." : "Next"}
            </button>
          </div>
        </form>
      )}

      {step === "review" && (
        <form action={createFormAction} className="space-y-5">
          <input type="hidden" name="ownerEmail" value={ownerEmail} />
          <p className="text-sm text-[var(--muted-foreground)]">Review and edit your agent&apos;s configuration:</p>
          <div>
            <label htmlFor="agent-name" className="block text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
              Agent Name
            </label>
            <input
              id="agent-name"
              name="name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Fred"
              className="w-full border rounded-lg p-3 text-sm"
            />
          </div>
          {[
            { id: "soul", label: "SOUL (personality & style)", value: soul, setter: setSoul },
            { id: "boundaries", label: "BOUNDARIES (constraints & rules)", value: boundaries, setter: setBoundaries },
            { id: "tools", label: "TOOLS (capabilities)", value: tools, setter: setTools },
          ].map(({ id, label, value, setter }) => (
            <div key={id}>
              <label htmlFor={`agent-${id}`} className="block text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
                {label}
              </label>
              <textarea
                id={`agent-${id}`}
                name={id}
                value={value}
                onChange={(event) => setter(event.target.value)}
                className="w-full border rounded-lg p-3 h-28 resize-y text-sm"
              />
            </div>
          ))}
          <div>
            <label htmlFor="agent-signatureDescription" className="block text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
              EMAIL SIGNATURE (one-line bio)
            </label>
            <textarea
              id="agent-signatureDescription"
              name="signatureDescription"
              value={signatureDescription}
              onChange={(event) => setSignatureDescription(event.target.value)}
              placeholder="Inbox concierge for the Smith household."
              className="w-full border rounded-lg p-3 h-16 resize-y text-sm"
            />
            <p className="text-[10px] text-[var(--muted)] mt-1.5">
              Appears in the footer of every email the agent sends, alongside its name and avatar.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep("questions")}
              className="border border-[var(--card-border)] text-[var(--muted-foreground)] px-6 py-2.5 rounded-lg text-sm hover:bg-[rgba(255,255,255,0.04)] transition-colors"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={createPending || !name}
              className="bg-[var(--accent)] text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:brightness-110 disabled:opacity-40 transition-all"
            >
              {createPending ? "Creating agent..." : "Create Agent"}
            </button>
          </div>
        </form>
      )}

      {step === "done" && agent && (
        <div className="text-center space-y-4 py-8">
          {agent.profileImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={agent.profileImageUrl}
              alt={`${name || "Agent"} avatar`}
              className="w-20 h-20 rounded-2xl mx-auto mb-2 object-cover border border-[var(--card-border)]"
            />
          ) : (
            <div className="w-20 h-20 rounded-2xl mx-auto mb-2 bg-[var(--accent-muted)] border border-[var(--card-border)] flex items-center justify-center">
              <span className="text-[var(--accent)] text-2xl font-[family-name:var(--font-outfit)] font-bold">
                {(name || "A").charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <h2 className="font-[family-name:var(--font-outfit)] text-xl font-semibold">Agent Created</h2>
          <p className="text-sm text-[var(--muted-foreground)]">Your agent is ready. Its email address is:</p>
          <p className="font-mono text-sm bg-[rgba(255,255,255,0.04)] border border-[var(--card-border)] inline-block px-4 py-2 rounded-lg text-[var(--accent)]">
            {agent.agentEmail}
          </p>
          <p className="text-xs text-[var(--muted)]">
            Head to the dashboard to create your first task.
          </p>
          <div className="flex gap-3 justify-center mt-6">
            <Link
              href={controlPlanePath(agent.agentId, "root")}
              className="bg-[var(--accent)] text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:brightness-110 transition-all"
            >
              Go to Dashboard
            </Link>
            <Link
              href="/agents"
              className="border border-[var(--card-border)] text-[var(--muted-foreground)] px-6 py-2.5 rounded-lg text-sm hover:bg-[rgba(255,255,255,0.04)] transition-colors"
            >
              All Agents
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
