import type { Metadata } from "next";
import { NewMessage } from "@/components/messages/new-message";

export const metadata: Metadata = { title: "New message" };

export default function NewMessagePage() {
  return <NewMessage />;
}
