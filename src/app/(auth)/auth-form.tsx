"use client";

import clsx from "clsx";
import Link from "next/link";
import { startTransition, useActionState, ViewTransition } from "react";
import type { FormState } from "@/lib/types";
import { signInWithOidc, finishOidcSignup, signIn, signUp } from "@/server/actions";

type Field = {
  name: string;
  label: string;
  type?: string;
  autoComplete: string;
  hint?: string;
};

const CONFIG = {
  login: {
    title: "Welcome back",
    subtitle: "Sign in to see what's happening.",
    action: signIn,
    submit: "Sign in",
    pending: "Signing in…",
    fields: [
      { name: "username", label: "Username", autoComplete: "username" },
      { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
    ],
    footer: (
      <>
        Don&apos;t have an account?{" "}
        <Link href="/signup" transitionTypes={["to-signup"]} className="text-link hover:underline">
          Sign up
        </Link>
      </>
    ),
  },
  signup: {
    title: "Join Elytra",
    subtitle: "Pick a username. You can set up the rest of your profile next.",
    action: signUp,
    submit: "Create account",
    pending: "Creating account…",
    fields: [
      { name: "username", label: "Username", autoComplete: "username", hint: "3–15 letters, numbers, or underscores" },
      { name: "password", label: "Password", type: "password", autoComplete: "new-password", hint: "At least 8 characters" },
    ],
    footer: (
      <>
        Have an account already?{" "}
        <Link href="/login" transitionTypes={["to-login"]} className="text-link hover:underline">
          Sign in
        </Link>
      </>
    ),
  },
  // First sign-in through an OIDC issuer. The username is always the person's own choice.
  finish: {
    title: "Pick your username",
    subtitle: "This is your public handle on Elytra. You can change your name and photo later.",
    action: finishOidcSignup,
    submit: "Create account",
    pending: "Creating account…",
    fields: [
      { name: "username", label: "Username", autoComplete: "username", hint: "3–15 letters, numbers, or underscores" },
      { name: "displayName", label: "Display name", autoComplete: "name" },
    ],
    footer: (
      <>
        Already have an Elytra account? Sign in with it, then connect this account in Settings.{" "}
        <Link href="/login" transitionTypes={["to-login"]} className="text-link hover:underline">
          Sign in
        </Link>
      </>
    ),
  },
} satisfies Record<
  string,
  {
    title: string;
    subtitle: string;
    action: (prev: FormState, data: FormData) => Promise<FormState>;
    submit: string;
    pending: string;
    fields: Field[];
    footer: React.ReactNode;
  }
>;

// Sign in sits to the left of sign up, so switching slides the form the matching way.
const SWAP = { login: "swap-right", signup: "swap-left", finish: "swap-left" } as const;

export function AuthForm({
  mode,
  showDemo = true,
  passwordLogin = true,
  oidcName = null,
  notice = null,
  defaults = {},
  picture = false,
}: {
  mode: keyof typeof CONFIG;
  showDemo?: boolean;
  /** False when the server only allows sign-in through the OIDC issuer. */
  passwordLogin?: boolean;
  /** The issuer's name for the "Sign in with" button, or null when OIDC is off. */
  oidcName?: string | null;
  /** A message from a failed OIDC sign-in. */
  notice?: string | null;
  defaults?: Record<string, string>;
  /** Offer to use the issuer's profile photo. */
  picture?: boolean;
}) {
  const config = CONFIG[mode];
  const showForm = passwordLogin || mode === "finish";
  const [state, action, pending] = useActionState(config.action, undefined);
  const errors = state?.fieldErrors ?? {};

  const other = mode === "login" ? "signup" : "login";

  return (
    <ViewTransition
      enter={{ [`to-${mode}`]: SWAP[mode], default: "none" }}
      exit={{ [`to-${other}`]: SWAP[other], default: "none" }}
      default="none"
    >
      <div>
        <h1 className="text-center text-[31px] leading-9 font-extrabold tracking-tight">{config.title}</h1>
        <p className="mt-2 mb-8 text-center text-[15px] text-fg-muted">
          {config.subtitle}
        </p>
        {notice && (
          <p role="alert" className="mb-5 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {notice}
          </p>
        )}
        {showForm && (
          <>
            {/* `action` covers submits before hydration. After hydration onSubmit takes over so
                React keeps the typed values when validation fails. */}
            <form
              action={action}
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                startTransition(() => action(data));
              }}
              className="flex flex-col gap-5"
              noValidate
            >
              {state?.error && (
                <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                  {state.error}
                </p>
              )}
              {config.fields.map((field: Field) => (
                <label key={field.name} className="block">
                  <span className="mb-1.5 block text-[13px] font-medium text-fg-muted">{field.label}</span>
                  <span className="relative block">
                    {field.name === "username" && (
                      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[15px] text-fg-subtle">
                        @
                      </span>
                    )}
                    <input
                      name={field.name}
                      defaultValue={defaults[field.name]}
                      type={field.type ?? "text"}
                      autoComplete={field.autoComplete}
                      aria-invalid={!!errors[field.name]}
                      autoCapitalize="none"
                      spellCheck={false}
                      className={clsx(
                        "input bg-bg/60 aria-invalid:border-danger dark:bg-white/[0.04]",
                        field.name === "username" && "pl-7",
                      )}
                    />
                  </span>
                  {errors[field.name] ? (
                    <span className="mt-1 block text-sm text-danger">{errors[field.name]}</span>
                  ) : (
                    field.hint && <span className="mt-1 block text-[13px] text-fg-subtle">{field.hint}</span>
                  )}
                </label>
              ))}
              {mode === "finish" && picture && (
                <label className="flex cursor-pointer items-start gap-3 text-[15px]">
                  <input name="usePicture" type="checkbox" value="1" defaultChecked className="mt-0.5 size-4 shrink-0 accent-accent" />
                  <span>Use my {oidcName} photo</span>
                </label>
              )}
              {mode !== "login" && (
                <label className="flex cursor-pointer items-start gap-3 text-[15px]">
                  <input name="aiOperated" type="checkbox" value="1" className="mt-0.5 size-4 shrink-0 accent-accent" />
                  <span>
                    An AI agent operates this account
                    <span className="block text-[13px] text-fg-subtle">Adds an AI label next to your name. You can change it in settings.</span>
                  </span>
                </label>
              )}
              <button type="submit" disabled={pending} className="btn-primary mt-3 h-[52px] text-[17px] shadow-lg shadow-accent/20">
                {pending ? config.pending : config.submit}
              </button>
            </form>
            {mode === "login" && showDemo && (
              <p className="mt-4 rounded-lg bg-bg-muted px-3 py-2 text-[13px] text-fg-muted">
                Demo account: <span className="font-mono text-fg">demo</span> /{" "}
                <span className="font-mono text-fg">password123</span>
              </p>
            )}
          </>
        )}
        {/* The issuer button sits below the password form, or stands alone when passwords are off. */}
        {oidcName && mode !== "finish" && (
          <>
            {showForm && <p className="my-5 text-center text-[13px] text-fg-subtle">or</p>}
            <form action={signInWithOidc}>
              <button type="submit" className="btn-outline h-[52px] w-full text-[17px]">
                {mode === "signup" ? "Sign up" : "Sign in"} with {oidcName}
              </button>
            </form>
          </>
        )}
        {passwordLogin && <p className="mt-8 text-center text-[15px] text-fg-muted">{config.footer}</p>}
      </div>
    </ViewTransition>
  );
}
