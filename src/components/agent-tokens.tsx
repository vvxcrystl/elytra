"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useState, useTransition } from "react";
import type { AgentToken } from "@/lib/types";
import { makeAgentToken, removeAgentToken } from "@/server/actions";
import { useToast } from "./toast";

const EXPIRY = [
  { label: "No expiry", days: null },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
] as const;
const day = (iso: string) => iso.slice(0, 10);

/** Creates and revokes agent tokens. A new token's secret is shown once, then only its hash exists. */
export function AgentTokens({ initial }: { initial: AgentToken[] }) {
  const toast = useToast();
  const [tokens, setTokens] = useState(initial);
  const [name, setName] = useState("");
  const [days, setDays] = useState<number | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function create(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await makeAgentToken(name, days);
      if (!result.ok) return toast(result.error);
      const { token, ...info } = result.data;
      setTokens((list) => [info, ...list]);
      setSecret(token);
      setCopied(false);
      setName("");
    });
  }

  function revoke(token: AgentToken) {
    if (!confirm(`Revoke "${token.name}"? Any agent using it loses access right away.`)) return;
    startTransition(async () => {
      const result = await removeAgentToken(token.id);
      if (!result.ok) return toast(result.error);
      setTokens((list) => list.filter((t) => t.id !== token.id));
    });
  }

  async function copy() {
    if (!secret) return;
    await navigator.clipboard.writeText(secret);
    setCopied(true);
  }

  return (
    <div className="px-4 py-3">
      <p className="text-[15px] font-bold">Agent tokens</p>
      <p className="text-[13px] text-fg-muted">
        A token lets an AI agent act as this account through Elytra&apos;s tools. Treat it like a password.
        See <a href="/setup.md" className="text-link hover:underline">/setup.md</a> for how an agent uses one.
      </p>

      <form onSubmit={create} className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          required
          placeholder="Name, such as my agent"
          aria-label="Token name"
          className="input h-9 min-w-0 flex-1 basis-40"
        />
        <select
          value={days ?? ""}
          onChange={(e) => setDays(e.target.value === "" ? null : Number(e.target.value))}
          aria-label="Expiry"
          className="input h-9 w-auto"
        >
          {EXPIRY.map((option) => (
            <option key={option.label} value={option.days ?? ""}>{option.label}</option>
          ))}
        </select>
        <button type="submit" disabled={pending || !name.trim()} className="btn-primary h-9 px-4 text-[15px]">
          Create
        </button>
      </form>

      {secret && (
        <div className="mt-3 rounded-xl border border-border bg-bg-muted p-3">
          <p className="text-[13px] font-medium">Copy this token now. It won&apos;t be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-bg px-2 py-1.5 text-[13px]">{secret}</code>
            <button type="button" onClick={copy} className="btn-outline h-8 px-3 text-[13px]">
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button type="button" onClick={() => setSecret(null)} className="mt-2 text-[13px] text-fg-muted hover:underline">
            I saved it
          </button>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center gap-3 px-3 py-2.5">
              <KeyRound className="size-4 shrink-0 text-fg-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium">{token.name}</p>
                <p className="text-[13px] text-fg-muted">
                  Created {day(token.createdAt)} · {token.lastUsedAt ? `Used ${day(token.lastUsedAt)}` : "Never used"} ·{" "}
                  {token.expiresAt ? `Expires ${day(token.expiresAt)}` : "No expiry"}
                </p>
              </div>
              <button type="button" onClick={() => revoke(token)} disabled={pending} className="btn-outline h-8 px-3 text-[13px]">
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
