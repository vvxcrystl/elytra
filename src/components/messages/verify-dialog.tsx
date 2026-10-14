"use client";

import { ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "../spinner";
import { errorMessage } from "./api";
import { verifyConversationKeys } from "./encryption";

export type EncryptionInfo = { safetyNumber: string | null; verified: boolean; recipientReady: boolean };

/**
 * Shows the conversation's safety number. Marks the keys verified only after the viewer says
 * they compared it with the other person outside Elytra.
 */
export function VerifyDialog({
  open,
  onClose,
  conversationId,
  username,
  info,
  onVerified,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  username: string;
  info: EncryptionInfo;
  onVerified: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await verifyConversationKeys(conversationId);
      onVerified();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={() => {
        setError(null);
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      aria-labelledby="verify-title"
      className="m-auto w-[calc(100%-2rem)] max-w-[440px] rounded-2xl bg-bg text-fg backdrop:bg-overlay"
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <h2 id="verify-title" className="flex-1 text-xl font-bold">
          Verify encryption
        </h2>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close"
          className="-mr-2 flex size-9 items-center justify-center rounded-full hover:bg-bg-hover"
        >
          <X className="size-5" />
        </button>
      </div>
      <div className="px-4 pt-2 pb-5">
        {info.safetyNumber === null ? (
          <p className="text-[15px] text-fg-muted">
            @{username} hasn&apos;t set up encrypted messages yet, so there&apos;s no safety number
            to compare.
          </p>
        ) : (
          <>
            <p className="text-[15px] text-fg-muted">
              Messages with @{username} are end-to-end encrypted. To make sure nobody is in the
              middle, compare this safety number with theirs in person, on a call, or over
              another app you trust. Don&apos;t compare it over Elytra messages.
            </p>
            <p
              aria-label="Safety number"
              className="mt-4 rounded-xl border border-border bg-bg-muted px-4 py-3 text-center font-mono text-[17px] leading-7 tracking-wide break-words whitespace-pre-wrap select-all"
            >
              {info.safetyNumber}
            </p>
            {info.verified ? (
              <p className="mt-4 flex items-center gap-2 text-[15px] font-semibold text-accent-ink">
                <ShieldCheck className="size-5 shrink-0" />
                You verified @{username}&apos;s keys.
              </p>
            ) : (
              <>
                {error && (
                  <p role="alert" className="mt-4 text-[15px] text-danger">
                    {error}
                  </p>
                )}
                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={confirm}
                    disabled={busy}
                    className="btn-primary h-10 px-5 text-[15px]"
                  >
                    {busy && <Spinner className="size-4" />}
                    The numbers match
                  </button>
                  <button
                    type="button"
                    onClick={() => dialogRef.current?.close()}
                    className="btn-outline h-10 px-5 text-[15px]"
                  >
                    Not now
                  </button>
                </div>
                <p className="mt-3 text-[13px] text-fg-muted">
                  If the numbers don&apos;t match, don&apos;t mark them verified. Someone may be
                  intercepting this conversation.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
