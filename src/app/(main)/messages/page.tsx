import type { Metadata } from "next";
import { Inbox } from "@/components/messages/inbox";

export const metadata: Metadata = { title: "Messages" };

export default function MessagesPage() {
  return <Inbox />;
}
