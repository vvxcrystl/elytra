import { EncryptionGate } from "@/components/messages/encryption-gate";

export default function MessagesLayout({ children }: LayoutProps<"/messages">) {
  return <EncryptionGate>{children}</EncryptionGate>;
}
