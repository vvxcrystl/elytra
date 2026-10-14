import type { Metadata } from "next";
import { EditProfileButton } from "@/components/edit-profile";
import { PageHeader } from "@/components/page-header";
import { ThemePicker } from "@/components/theme";
import { signOut } from "@/server/actions";
import { requireViewer } from "@/server/auth";
import { getProfile } from "@/server/queries";
import { SettingsRow, SettingsSection } from "./settings-section";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const viewer = await requireViewer();
  const profile = await getProfile(viewer.username);

  return (
    <>
      <PageHeader back title="Settings" />
      <SettingsSection title="Account">
        {profile && (
          <SettingsRow title="Profile" description="Name, bio, location, website, avatar, and banner.">
            <EditProfileButton profile={profile} />
          </SettingsRow>
        )}
        <SettingsRow title="Log out" description={`Signed in as @${viewer.username}`}>
          <form action={signOut}>
            <button type="submit" className="btn-outline h-9 px-4 text-[15px]">
              Log out
            </button>
          </form>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Appearance">
        <SettingsRow title="Theme" description="Choose a light, dark, or system theme.">
          <ThemePicker />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
