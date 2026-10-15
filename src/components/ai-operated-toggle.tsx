"use client";

import { useState, useTransition } from "react";
import { updateAiOperated } from "@/server/actions";
import { useToast } from "./toast";

/** Checkbox for declaring that an AI agent operates the account. Disabled while an operator override applies. */
export function AiOperatedToggle({ checked, locked }: { checked: boolean; locked: boolean }) {
  const toast = useToast();
  const [value, setValue] = useState(checked);
  const [pending, startTransition] = useTransition();

  function onChange(next: boolean) {
    const previous = value;
    setValue(next);
    startTransition(async () => {
      const result = await updateAiOperated(next);
      if (!result.ok) {
        setValue(previous);
        toast(result.error);
      }
    });
  }

  return (
    <input
      type="checkbox"
      checked={value}
      disabled={locked || pending}
      onChange={(e) => onChange(e.target.checked)}
      aria-label="Account operated by AI"
      className="size-5 shrink-0 accent-accent"
    />
  );
}
