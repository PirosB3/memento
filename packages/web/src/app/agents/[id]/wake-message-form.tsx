"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function WakeMessageForm({
  endpoint,
  label,
  placeholder,
  failureMessage = "Failed to send wake message.",
}: {
  endpoint: string;
  label: string;
  placeholder: string;
  failureMessage?: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setError("Message is required.");
      return;
    }

    setError(null);
    setIsPending(true);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: trimmedMessage }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? failureMessage);
        return;
      }

      setMessage("");
      router.refresh();
    } catch {
      setError(failureMessage);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4 space-y-2">
      <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={placeholder}
          className="flex-1 border rounded-lg p-2 text-sm"
          disabled={isPending}
        />
        <button
          type="submit"
          disabled={isPending || message.trim().length === 0}
          className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {isPending ? "Sending..." : "Wake"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
