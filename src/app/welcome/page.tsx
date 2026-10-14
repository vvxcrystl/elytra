import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Backdrop } from "@/components/backdrop";
import { ToastProvider } from "@/components/toast";
import { requireViewer } from "@/server/auth";
import { getProfile, getWhoToFollow } from "@/server/queries";
import { Onboarding } from "./onboarding";

export const metadata: Metadata = { title: "Welcome" };

export default async function WelcomePage() {
  const viewer = await requireViewer();
  const [profile, suggestions] = await Promise.all([getProfile(viewer.username), getWhoToFollow(6)]);
  if (!profile) notFound();

  return (
    <div className="relative isolate flex min-h-dvh items-center justify-center p-4 sm:p-6">
      <Backdrop />
      <ToastProvider>
        <Onboarding profile={profile} suggestions={suggestions} />
      </ToastProvider>
    </div>
  );
}
