"use client";

import { Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "../spinner";
import { useToast } from "../toast";
import { errorMessage, openConversationId } from "./api";

/**
 * Profile header button that opens (or creates) the conversation with this user. It sits
 * outside the encryption gate, so it only fetches the id; the gate takes over on navigation.
 */
export function MessageButton({ userId, username }: { userId: string; username: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      const id = await openConversationId(userId);
      router.push(`/messages/${id}`);
    } catch (err) {
      toast(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-label={`Message @${username}`}
      title="Message"
      className="btn-outline size-9"
    >
      {pending ? <Spinner className="size-4" /> : <Mail className="size-[18px]" />}
    </button>
  );
}
