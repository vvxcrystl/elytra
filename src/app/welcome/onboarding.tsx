"use client";

import clsx from "clsx";
import { ArrowLeft, Camera, Check } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import { GLASS_CARD } from "@/components/backdrop";
import { FollowButton } from "@/components/follow-button";
import { Logo } from "@/components/logo";
import { useProfileImageUpload } from "@/components/use-profile-image-upload";
import type { Profile, UserListItem } from "@/lib/types";
import { saveOnboardingProfile } from "@/server/actions";

const STEPS = ["Profile", "Bio", "Follow", "Done"] as const;

export function Onboarding({ profile, suggestions: initialSuggestions }: { profile: Profile; suggestions: UserListItem[] }) {
  const [step, setStep] = useState(0);
  // Following someone revalidates the page, and the server drops followed accounts from suggestions.
  // Keep the first list so rows don't disappear as the user follows them.
  const [suggestions] = useState(initialSuggestions);
  const [state, action, pending] = useActionState(saveOnboardingProfile, undefined);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio);
  const { file: avatarFile, preview: avatarPreview, selectImage: selectAvatar, cropDialog, error: avatarError } = useProfileImageUpload("avatar");
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const errors = state?.fieldErrors ?? {};

  // The profile saves when the bio step submits. Move on if it worked, or back to the name step if the name was rejected.
  const [handled, setHandled] = useState(state);
  if (state !== handled) {
    setHandled(state);
    if (state?.success) setStep(2);
    else if (state?.fieldErrors?.displayName) setStep(0);
  }

  const preview = { id: profile.id, displayName: displayName.trim() || profile.username, avatarUrl: avatarPreview ?? profile.avatarUrl };

  return (
    <div className={`w-full max-w-[520px] ${GLASS_CARD}`}>
      <header className="flex items-center gap-3 px-6 pt-6">
        <div className="flex size-10 items-center">
          {step > 0 && step < 3 && (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              aria-label="Back"
              className="flex size-9 items-center justify-center rounded-full hover:bg-bg-hover"
            >
              <ArrowLeft className="size-5" />
            </button>
          )}
        </div>
        <ol className="flex flex-1 items-center justify-center gap-2" aria-label="Progress">
          {STEPS.map((label, i) => (
            <li
              key={label}
              aria-current={i === step ? "step" : undefined}
              className={clsx(
                "h-1.5 rounded-full transition-all duration-300",
                i === step ? "w-8 bg-accent" : i < step ? "w-4 bg-accent/60" : "w-4 bg-border",
              )}
            >
              <span className="sr-only">{label}</span>
            </li>
          ))}
        </ol>
        <div className="flex w-10 justify-end">
          {step < 3 && (
            <Link href="/home" className="text-[13px] font-medium whitespace-nowrap text-fg-muted hover:text-fg">
              Skip
            </Link>
          )}
        </div>
      </header>

      {/* Steps 0 and 1 share one form so the chosen avatar file survives moving between them. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 0) return setStep(1);
          const data = new FormData(e.currentTarget);
          if (avatarFile) data.set("avatar", avatarFile);
          startTransition(() => action(data));
        }}
        className={clsx("px-8 pt-6 pb-10 sm:px-12", step > 1 && "hidden")}
        noValidate
      >
        <section hidden={step !== 0} className="motion-safe:animate-[step-in_300ms_ease-out_both]">
          <Heading title="Make it yours" subtitle="Add a photo and the name people will see on your posts." />
          <div className="relative mx-auto mb-8 w-fit">
            <button type="button" onClick={() => avatarInputRef.current?.click()} disabled={pending} className="group relative block cursor-pointer rounded-full" aria-label="Choose a profile photo">
              <span className="absolute -inset-2 rounded-full bg-gradient-to-tr from-accent/70 via-accent/20 to-transparent blur-md transition-opacity group-hover:opacity-100 opacity-70" />
              <span className="relative block rounded-full ring-4 ring-bg">
                <Avatar user={preview} className="size-28! text-4xl!" />
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-white opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
                  <Camera className="size-6" />
                </span>
              </span>
              <span className="absolute right-0 bottom-0 flex size-9 items-center justify-center rounded-full bg-accent text-accent-fg ring-4 ring-bg">
                <Camera className="size-4" />
              </span>
            </button>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={selectAvatar}
            />
          </div>
          {avatarError && <p role="alert" className="mb-4 text-sm text-danger">{avatarError}</p>}
          <label className="block">
            <span className="mb-1.5 flex justify-between text-[13px] font-medium text-fg-muted">
              Display name
              <span className="tabular-nums">{[...displayName].length} / 50</span>
            </span>
            <input
              name="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={50}
              autoFocus
              aria-invalid={!!errors.displayName}
              className="input bg-bg/60 dark:bg-white/[0.04] aria-invalid:border-danger"
            />
            <span className="mt-1 block text-[13px] text-fg-subtle">
              {errors.displayName ? <span className="text-danger">{errors.displayName}</span> : <>Your username stays @{profile.username}.</>}
            </span>
          </label>
          <button type="submit" disabled={!displayName.trim()} className="btn-primary mt-8 h-[52px] w-full text-[17px] shadow-lg shadow-accent/20">
            Continue
          </button>
        </section>

        <section hidden={step !== 1} className="motion-safe:animate-[step-in_300ms_ease-out_both]">
          <Heading title="Describe yourself" subtitle="What makes you special? A line or two is plenty." />
          <label className="block">
            <span className="mb-1.5 flex justify-between text-[13px] font-medium text-fg-muted">
              Bio
              <span className="tabular-nums">{bio.length} / 160</span>
            </span>
            <textarea
              name="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={160}
              rows={4}
              placeholder="Coffee, synths, and long walks."
              aria-invalid={!!errors.bio}
              className="input resize-none bg-bg/60 dark:bg-white/[0.04] aria-invalid:border-danger"
            />
            {errors.bio && <span className="mt-1 block text-sm text-danger">{errors.bio}</span>}
          </label>
          {state?.error && (
            <p role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {state.error}
            </p>
          )}
          <button type="submit" disabled={pending} className="btn-primary mt-8 h-[52px] w-full text-[17px] shadow-lg shadow-accent/20">
            {pending ? "Saving…" : bio.trim() ? "Continue" : "Skip for now"}
          </button>
        </section>
      </form>
      {cropDialog}

      {step === 2 && (
        <section className="motion-safe:animate-[step-in_300ms_ease-out_both] px-8 pt-6 pb-10 sm:px-12">
          <Heading title="Find your people" subtitle="Follow a few accounts to fill your home timeline." />
          {suggestions.length ? (
            <ul className="-mx-3 flex max-h-[340px] flex-col overflow-y-auto">
              {suggestions.map((user) => (
                <li key={user.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-bg-hover">
                  <Avatar user={user} />
                  <div className="min-w-0 flex-1 leading-5">
                    <p className="truncate font-bold">{user.displayName}</p>
                    <p className="truncate text-[15px] text-fg-muted">@{user.username}</p>
                    {user.bio && <p className="mt-0.5 line-clamp-1 text-[13px] text-fg-muted">{user.bio}</p>}
                  </div>
                  <FollowButton userId={user.id} following={user.isFollowing} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-center text-[15px] text-fg-muted">No suggestions yet. You can find people from Explore.</p>
          )}
          <button type="button" onClick={() => setStep(3)} className="btn-primary mt-8 h-[52px] w-full text-[17px] shadow-lg shadow-accent/20">
            Continue
          </button>
        </section>
      )}

      {step === 3 && (
        <section className="motion-safe:animate-[step-in_300ms_ease-out_both] flex flex-col items-center px-8 pt-6 pb-10 text-center sm:px-12">
          <div className="relative mb-6">
            <span className="absolute -inset-4 rounded-full bg-accent/30 blur-xl" />
            <Avatar user={preview} className="relative size-24! text-3xl! ring-4 ring-bg" />
            <span className="absolute -right-1 -bottom-1 flex size-8 items-center justify-center rounded-full bg-accent text-accent-fg ring-4 ring-bg">
              <Check className="size-4" strokeWidth={3} />
            </span>
          </div>
          <h1 className="text-[31px] leading-9 font-extrabold tracking-tight">You&apos;re all set, {preview.displayName}</h1>
          <p className="mt-2 text-[15px] text-fg-muted">Your profile lives at @{profile.username}. Say hello with your first post.</p>
          <Link href="/home" className="btn-primary mt-8 h-[52px] w-full text-[17px] shadow-lg shadow-accent/20">
            Go to Elytra
          </Link>
        </section>
      )}
    </div>
  );
}

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-8 text-center">
      <Logo className="mx-auto mb-4 size-8" />
      <h1 className="text-[31px] leading-9 font-extrabold tracking-tight">{title}</h1>
      <p className="mt-2 text-[15px] text-fg-muted">{subtitle}</p>
    </div>
  );
}
