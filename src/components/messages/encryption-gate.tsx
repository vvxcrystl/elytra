"use client";

import { Check, Copy, Download, KeyRound, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";
import { Spinner } from "../spinner";
import { useViewer } from "../viewer-context";
import { errorMessage } from "./api";
import {
  activateEncryption,
  forgetEncryption,
  initializeEncryption,
  prepareEncryption,
  recoverEncryption,
} from "./encryption";
import { MessagesHeader } from "./messages-header";

/**
 * Wraps every /messages page. Children only render once this browser holds the viewer's
 * message keys. Keyed by viewer so switching accounts starts from scratch.
 */
export function EncryptionGate({ children }: { children: React.ReactNode }) {
  const viewer = useViewer();
  return (
    <Gate key={viewer.id} userId={viewer.id}>
      {children}
    </Gate>
  );
}

type GateState =
  | { step: "loading" }
  | { step: "load-error"; message: string }
  | { step: "setup" }
  | { step: "recovery" }
  | { step: "ready" };

function Gate({ userId, children }: { userId: string; children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ step: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    initializeEncryption(userId).then(
      (status) => {
        if (!cancelled) setState({ step: status });
      },
      (err) => {
        // Fail closed: a load error never falls through to the messages.
        if (!cancelled) setState({ step: "load-error", message: errorMessage(err) });
      },
    );
    return () => {
      cancelled = true;
      forgetEncryption();
    };
  }, [userId, attempt]);

  if (state.step === "ready") return children;

  return (
    <>
      <MessagesHeader title="Messages" />
      {state.step === "loading" ? (
        <div className="flex justify-center py-10" aria-label="Loading encryption keys">
          <Spinner />
        </div>
      ) : state.step === "load-error" ? (
        <GatePanel title="Couldn't load your message keys">
          <ErrorText message={state.message} />
          <p className="mt-2 text-[15px] text-fg-muted">
            Messages stay locked until your keys load. Nothing was reset.
          </p>
          <button
            type="button"
            onClick={() => {
              setState({ step: "loading" });
              setAttempt((n) => n + 1);
            }}
            className="btn-primary mt-6 h-11 px-6 text-[15px]"
          >
            Try again
          </button>
        </GatePanel>
      ) : state.step === "setup" ? (
        <SetupFlow userId={userId} onDone={() => setState({ step: "ready" })} />
      ) : (
        <RecoveryFlow userId={userId} onDone={() => setState({ step: "ready" })} />
      )}
    </>
  );
}

function SetupFlow({ userId, onDone }: { userId: string; onDone: () => void }) {
  // The recovery code lives only in this component's state. It is never sent to the
  // server or written to storage, URLs or logs.
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      setCode(await prepareEncryption(userId));
      setSaved(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!saved) return;
    setBusy(true);
    setError(null);
    try {
      await activateEncryption(userId);
      setCode(null);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Select the code and copy it by hand.");
    }
  }

  function download() {
    if (!code) return;
    const text = `Elytra message recovery code\n\n${code}\n\nKeep this private. Anyone with this code and your account can read your messages.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "elytra-recovery-code.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!code) {
    return (
      <GatePanel icon={<LockKeyhole className="size-6" />} title="Set up encrypted messages">
        <p className="text-[15px] text-fg-muted">
          Messages on Elytra are end-to-end encrypted. This browser will generate keys that only
          you hold, so Elytra&apos;s servers can&apos;t read your conversations.
        </p>
        <p className="mt-3 text-[15px] text-fg-muted">
          You&apos;ll get a recovery code next. You need it to read your messages on another
          browser or device. Elytra can&apos;t recover it for you.
        </p>
        {error && <ErrorText message={error} />}
        <button
          type="button"
          onClick={prepare}
          disabled={busy}
          className="btn-primary mt-6 h-11 px-6 text-[15px]"
        >
          {busy && <Spinner className="size-4" />}
          Generate keys
        </button>
      </GatePanel>
    );
  }

  return (
    <GatePanel icon={<KeyRound className="size-6" />} title="Save your recovery code">
      <p className="text-[15px] text-fg-muted">
        Store this somewhere safe, like a password manager. It&apos;s shown once and never leaves
        this browser. Without it you can&apos;t read your messages anywhere else.
      </p>
      <p
        aria-label="Recovery code"
        className="mt-4 rounded-xl border border-border bg-bg-muted px-4 py-3 font-mono text-[15px] leading-6 break-all select-all"
      >
        {code}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={copy} className="btn-outline h-9 px-4 text-sm">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={download} className="btn-outline h-9 px-4 text-sm">
          <Download className="size-4" />
          Download
        </button>
      </div>
      <label className="mt-5 flex cursor-pointer items-start gap-3 text-[15px]">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-accent"
        />
        I saved my recovery code
      </label>
      {error && <ErrorText message={error} />}
      <button
        type="button"
        onClick={activate}
        disabled={!saved || busy}
        className="btn-primary mt-6 h-11 px-6 text-[15px]"
      >
        {busy && <Spinner className="size-4" />}
        Turn on encrypted messages
      </button>
    </GatePanel>
  );
}

function RecoveryFlow({ userId, onDone }: { userId: string; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore(e: React.FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await recoverEncryption(userId, value);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCode("");
      setBusy(false);
    }
  }

  return (
    <GatePanel icon={<KeyRound className="size-6" />} title="Unlock your messages">
      <p className="text-[15px] text-fg-muted">
        You set up encrypted messages on another browser. Enter the recovery code you saved then
        to read and send messages here. The code is checked in this browser and never sent to
        Elytra.
      </p>
      <form onSubmit={restore} className="mt-5">
        <label htmlFor="recovery-code" className="text-[13px] font-medium text-fg-muted">
          Recovery code
        </label>
        <textarea
          id="recovery-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (error) setError(null);
          }}
          rows={2}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          className="mt-1 w-full resize-none rounded-xl border border-border bg-bg-muted px-4 py-3 font-mono text-[15px] outline-none focus:border-accent-ink focus:bg-bg focus:ring-1 focus:ring-accent-ink"
        />
        {error && <ErrorText message={error} />}
        <button
          type="submit"
          disabled={!code.trim() || busy}
          className="btn-primary mt-4 h-11 px-6 text-[15px]"
        >
          {busy && <Spinner className="size-4" />}
          Restore
        </button>
      </form>
      <p className="mt-6 text-[13px] text-fg-muted">
        Lost your code? Open Messages on the browser where you set it up. Elytra doesn&apos;t
        have a copy and can&apos;t recover it for you.
      </p>
    </GatePanel>
  );
}

function GatePanel({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto max-w-[440px] px-6 py-10 sm:px-8">
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          {icon}
        </div>
      )}
      <h2 className="mb-3 text-[23px] leading-7 font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

function ErrorText({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-4 text-[15px] text-danger">
      {message}
    </p>
  );
}
