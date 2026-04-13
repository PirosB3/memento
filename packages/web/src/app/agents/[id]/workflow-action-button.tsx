"use client";

import { useFormStatus } from "react-dom";

function SubmitButton({
  idleLabel,
  pendingLabel,
  className,
}: {
  idleLabel: string;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={className ?? "text-[10px] font-medium transition-colors disabled:opacity-50"}
    >
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}

export default function WorkflowActionButton({
  action,
  confirmMessage,
  idleLabel,
  pendingLabel,
  className,
}: {
  action: () => Promise<void>;
  confirmMessage?: string;
  idleLabel: string;
  pendingLabel: string;
  className?: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (confirmMessage && !confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
    >
      <SubmitButton
        idleLabel={idleLabel}
        pendingLabel={pendingLabel}
        className={className}
      />
    </form>
  );
}
