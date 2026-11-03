import type { Metadata } from "next";
import { AgentTokens } from "@/components/agent-tokens";
import { AiOperatedToggle } from "@/components/ai-operated-toggle";
import { EditProfileButton } from "@/components/edit-profile";
import { PageHeader } from "@/components/page-header";
import { ThemePicker } from "@/components/theme";
import { connectOidcAccount, signOut } from "@/server/actions";
import { requireViewer } from "@/server/auth";
import { accountsConfig } from "@/server/config";
import { isLinked } from "@/server/data/identities";
import { oidcMessage } from "@/server/oidc";
import { getAgentTokens, getProfile } from "@/server/queries";
import { SettingsRow, SettingsSection } from "./settings-section";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const viewer = await requireViewer();
  const { oidc } = accountsConfig();
  const { oidc: code } = await searchParams;
  const linked = !!oidc && isLinked(viewer.id, oidc.issuer);
  const notice = code === "connected" ? null : oidcMessage(typeof code === "string" ? code : undefined);
  const [profile, agentTokens] = await Promise.all([getProfile(viewer.username), getAgentTokens()]);

  return (
    <>
      <PageHeader back title="Settings" />
      <SettingsSection title="Account">
        {profile && (
          <SettingsRow title="Profile" description="Name, bio, location, website, avatar, and banner.">
            <EditProfileButton profile={profile} />
          </SettingsRow>
        )}
        {profile && (
          <SettingsRow
            title="Account operated by AI"
            description={
              profile.aiOperatedLocked
                ? "Elytra set this label on your account, so you can't change it."
                : "Shows an AI label next to your name. Turn this on if an AI agent runs this account."
            }
          >
            <AiOperatedToggle checked={profile.aiOperated} locked={profile.aiOperatedLocked} />
          </SettingsRow>
        )}
        {oidc && (
          <SettingsRow
            title={`${oidc.name} account`}
            description={
              notice ??
              (linked
                ? `Connected. You can sign in with ${oidc.name}.`
                : `Connect it to sign in to this account with ${oidc.name}.`)
            }
          >
            {!linked && (
              <form action={connectOidcAccount}>
                <button type="submit" className="btn-outline h-9 px-4 text-[15px]">
                  Connect
                </button>
              </form>
            )}
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
      <SettingsSection title="Agent access">
        <AgentTokens initial={agentTokens} />
      </SettingsSection>
      <SettingsSection title="Appearance">
        <SettingsRow title="Theme" description="Choose a light, dark, or system theme.">
          <ThemePicker />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
