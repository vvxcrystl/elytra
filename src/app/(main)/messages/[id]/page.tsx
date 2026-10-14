import type { Metadata } from "next";
import { ConversationView } from "@/components/messages/conversation-view";

export const metadata: Metadata = { title: "Messages" };

export default async function ConversationPage({ params }: PageProps<"/messages/[id]">) {
  const { id } = await params;
  // Keyed so switching conversations starts from a clean state.
  return <ConversationView key={id} id={id} />;
}
