"use client";

import { Camera, X } from "lucide-react";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { Profile } from "@/lib/types";
import { updateProfile } from "@/server/actions";
import { Avatar } from "./avatar";
import { useToast } from "./toast";
import { useProfileImageUpload } from "./use-profile-image-upload";

export function EditProfileButton({ profile }: { profile: Profile }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState(0);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setKey((k) => k + 1);
          dialogRef.current?.showModal();
        }}
        className="btn-outline h-9 px-4 text-[15px]"
      >
        Edit profile
      </button>
      <dialog
        ref={dialogRef}
        aria-label="Edit profile"
        onClick={(e) => {
          if (e.target === e.currentTarget) dialogRef.current?.close();
        }}
        className="m-0 h-dvh max-h-none w-full max-w-none bg-bg text-fg sm:mx-auto sm:mt-[5vh] sm:bottom-auto sm:h-auto sm:max-h-[90vh] sm:max-w-[600px] sm:rounded-2xl"
      >
        {key > 0 && (
          <EditProfileForm
            key={key}
            profile={profile}
            onDone={() => dialogRef.current?.close()}
          />
        )}
      </dialog>
    </>
  );
}

function EditProfileForm({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const toast = useToast();
  const [state, action, pending] = useActionState(updateProfile, undefined);
  const { file: avatarFile, preview: avatarPreview, selectImage: selectAvatar, cropDialog, error: avatarError } = useProfileImageUpload("avatar");
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerUpload = useProfileImageUpload("banner");
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const [bio, setBio] = useState(profile.bio);

  useEffect(() => {
    if (state?.success) {
      toast("Profile updated");
      onDone();
    }
  }, [state, toast, onDone]);

  const banner = bannerUpload.removed ? null : (bannerUpload.preview ?? profile.bannerUrl);
  const errors = state?.fieldErrors ?? {};

  return (
    <>
      {/* Submit manually so validation failures keep the user's edits. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          if (avatarFile) data.set("avatar", avatarFile);
          if (bannerUpload.file) data.set("banner", bannerUpload.file);
          startTransition(() => action(data));
        }}
        className="flex flex-col"
      >
        <div className="sticky top-0 z-10 flex h-[53px] items-center gap-6 bg-bg/85 px-2 backdrop-blur">
          <button
            type="button"
            onClick={onDone}
            aria-label="Close"
            className="flex size-9 items-center justify-center rounded-full hover:bg-bg-hover"
          >
            <X className="size-5" />
          </button>
          <h2 className="flex-1 text-xl font-bold">Edit profile</h2>
          <button type="submit" disabled={pending} className="btn-inverse mr-2 h-8 px-4 text-sm">
            {pending ? "Saving…" : "Save"}
          </button>
        </div>

        <div className="relative aspect-[3/1] bg-bg-muted">
          {banner && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={banner} alt="" className="size-full object-cover" />
          )}
          <div className="absolute inset-0 flex items-center justify-center gap-4 bg-black/30">
            <button
              type="button"
              onClick={() => bannerInputRef.current?.click()}
              disabled={pending}
              className="flex size-11 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/70"
              aria-label="Change banner photo"
            >
              <Camera className="size-5" />
            </button>
            <input
              ref={bannerInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={bannerUpload.selectImage}
            />
            {banner && (
              <button
                type="button"
                onClick={bannerUpload.clearImage}
                disabled={pending}
                aria-label="Remove banner"
                className="flex size-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/70"
              >
                <X className="size-5" />
              </button>
            )}
          </div>
          {bannerUpload.removed && <input type="hidden" name="removeBanner" value="1" />}
        </div>

        <div className="px-4">
          <button type="button" onClick={() => avatarInputRef.current?.click()} disabled={pending} className="relative -mt-12 block w-fit cursor-pointer rounded-full border-4 border-bg" aria-label="Change profile photo">
            {avatarPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarPreview} alt="" className="size-24 rounded-full object-cover" />
            ) : (
              <Avatar user={profile} className="size-24! text-3xl!" />
            )}
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white">
              <Camera className="size-5" />
            </span>
          </button>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={selectAvatar}
          />

          <div className="flex flex-col gap-5 py-5">
            {state?.error && <p className="text-sm text-danger">{state.error}</p>}
            {avatarError && <p role="alert" className="text-sm text-danger">{avatarError}</p>}
            {bannerUpload.error && <p role="alert" className="text-sm text-danger">{bannerUpload.error}</p>}
            <Field label="Name" error={errors.displayName}>
              <input name="displayName" defaultValue={profile.displayName} maxLength={50} required className="input" />
            </Field>
            <Field label="Bio" error={errors.bio} hint={`${bio.length} / 160`}>
              <textarea
                name="bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                maxLength={160}
                rows={3}
                className="input resize-none"
              />
            </Field>
            <Field label="Location" error={errors.location}>
              <input name="location" defaultValue={profile.location} maxLength={30} className="input" />
            </Field>
            <Field label="Website" error={errors.website}>
              <input name="website" defaultValue={profile.website} maxLength={100} className="input" />
            </Field>
            {(errors.avatar || errors.banner) && (
              <p className="text-sm text-danger">{errors.avatar ?? errors.banner}</p>
            )}
          </div>
        </div>
      </form>
      {cropDialog}
      {bannerUpload.cropDialog}
    </>
  );
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex justify-between text-[13px] font-medium text-fg-muted">
        {label}
        {hint && <span className="tabular-nums">{hint}</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-sm text-danger">{error}</span>}
    </label>
  );
}
