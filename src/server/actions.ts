"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ActionResult, AgentToken, FormState, TimelineSource, Page, FeedItem } from "@/lib/types";
import { POST_MAX_IMAGES, POST_MAX_LENGTH } from "../lib/types";
import { getViewer, setSession } from "./auth";
import { getTimeline } from "./queries";
import { authenticate, createUser, deleteSession, setAiOperated, userByUsername, usernameProblem } from "./data/core";
import { createAgentToken, revokeAgentToken } from "./data/agent-tokens";
import { removePost, togglePostInteraction } from "./data/posts";
import { publishPost } from "./moderation/publication";
import { editProfile, profileByUsername, toggleFollowUser, readNotifications } from "./data/people";
import { validTimelineSource } from "./data/timeline";
import { saveImpressions, saveNotInterested } from "./data/feedback";
import { validateImage, saveImage, removeImages } from "./media";
import { sharedCapacity } from "./concurrency";
import { accountsConfig, backendConfig } from "./config";
import { trackAuthAttempt, limitRegistration, limitOidcStart } from "./rate-limit";
import { beginOidc, fetchPicture, pushProfileLater, SIGNUP_COOKIE, STATE_COOKIE } from "./oidc";
import { createUserFromSignup, pendingSignup } from "./data/identities";
import { AppError } from "./errors";

const SIGN_IN_ERROR = "You need to sign in";
const PASSWORD_OFF = "Password sign-in is turned off on this server";
const refresh = () => revalidatePath("/", "layout");
const text = (form: FormData, name: string) => { const value = form.get(name); return typeof value === "string" ? value : ""; };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Something went wrong";
function validId(id: unknown): id is string { return typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id); }
function optionalId(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (value === null || value === "") return null;
  if (!validId(value)) throw new Error("Invalid post ID");
  return value;
}
export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!accountsConfig().passwordLogin) return { error: PASSWORD_OFF };
  if (!(formData instanceof FormData)) return { error: "Invalid form" };
  // The display name starts as the username; onboarding at /welcome lets the user change it.
  const username = text(formData, "username").trim().replace(/^@/, ""), password = text(formData, "password");
  const fieldErrors: Record<string, string> = {};
  const problem = usernameProblem(username);
  if (problem) fieldErrors.username = problem;
  else if (userByUsername(username)) fieldErrors.username = "That username is already taken";
  if (password.length < 8) fieldErrors.password = "Password must be at least 8 characters";
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  let id: string;
  try { limitRegistration(await headers()); id = (await createUser(username, username, password, text(formData, "aiOperated") === "1")).id; }
  catch (error) {
    if (error instanceof AppError && error.code === "moderated_name") return { fieldErrors: { username: error.message } };
    if (userByUsername(username)) return { fieldErrors: { username: "That username is already taken" } };
    console.error("Unable to create account", error);
    return { error: "Unable to create your account. Please try again." };
  }
  await setSession(id);
  refresh();
  redirect("/welcome");
}
export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!accountsConfig().passwordLogin) return { error: PASSWORD_OFF };
  if (!(formData instanceof FormData)) return { error: "Invalid username or password" };
  const username = text(formData, "username").trim(), password = text(formData, "password");
  if (!/^[A-Za-z0-9_]{3,15}$/.test(username) || !password) return { error: "Invalid username or password" };
  let user;
  try {
    const attempt = trackAuthAttempt(await headers(), username);
    user = await authenticate(username, password);
    if (!user) attempt.throttleFailed();
    else attempt.clear();
  } catch (error) { return { error: errorMessage(error) }; }
  if (!user) return { error: "Invalid username or password" };
  await setSession(user.id);
  refresh();
  redirect("/home");
}
async function redirectToIssuer(linkUserId: string | null): Promise<never> {
  const config = accountsConfig().oidc, back = linkUserId ? "/settings" : "/login";
  if (!config) redirect(back);
  let url: string;
  try {
    limitOidcStart(await headers());
    const started = await beginOidc(config, linkUserId);
    // Lax so the cookie comes back on the provider's top-level redirect to the callback.
    (await cookies()).set(STATE_COOKIE, started.state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/oidc", maxAge: 600 });
    url = started.url;
  } catch (error) {
    console.error("Unable to start OIDC sign-in", error);
    redirect(`${back}?oidc=${error instanceof AppError && error.code === "rate_limited" ? "busy" : "provider"}`);
  }
  redirect(url);
}
/** "Sign in with CrystlCloud" on the sign-in page, and "Sign up with" on the sign-up page. */
export async function signInWithOidc(): Promise<void> { await redirectToIssuer(null); }
/** Settings: connect the signed-in account to an issuer account. */
export async function connectOidcAccount(): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  await redirectToIssuer(viewer.id);
}
/** First sign-in through the issuer: the person picks their Elytra username here. */
export async function finishOidcSignup(_prev: FormState, formData: FormData): Promise<FormState> {
  const config = accountsConfig().oidc;
  if (!config) return { error: "Sign-in with an account service is turned off" };
  if (!(formData instanceof FormData)) return { error: "Invalid form" };
  const jar = await cookies(), token = jar.get(SIGNUP_COOKIE)?.value ?? "";
  const identity = pendingSignup(token);
  if (!identity) return { error: "This sign-in expired. Go back and continue again." };
  const username = text(formData, "username").trim().replace(/^@/, ""), displayName = text(formData, "displayName").trim();
  const fieldErrors: Record<string, string> = {};
  const problem = usernameProblem(username);
  if (problem) fieldErrors.username = problem;
  else if (userByUsername(username)) fieldErrors.username = "That username is already taken";
  if (!displayName || [...displayName].length > 50) fieldErrors.displayName = "Display name must be 1–50 characters";
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  let avatarUrl: string | null = null, id: string;
  try {
    limitRegistration(await headers());
    // Fetch the photo before the transaction; a missing or invalid photo only skips it.
    if (identity.picture && text(formData, "usePicture") === "1") {
      const file = await fetchPicture(config, identity.picture);
      if (file) avatarUrl = await validateImage(file).then(saveImage).catch(() => null);
    }
    id = createUserFromSignup(token, { username, displayName, aiOperated: text(formData, "aiOperated") === "1", avatarUrl }).id;
  } catch (error) {
    if (avatarUrl) await removeImages([avatarUrl]);
    if (error instanceof AppError && error.code === "moderated_name") return { error: error.message };
    if (error instanceof AppError && error.code === "username_taken") return { fieldErrors: { username: error.message } };
    if (error instanceof AppError) return { error: error.message };
    console.error("Unable to create account", error);
    return { error: "Unable to create your account. Please try again." };
  }
  jar.delete({ name: SIGNUP_COOKIE, path: "/signup" });
  await setSession(id);
  refresh();
  redirect("/welcome");
}
export async function signOut(): Promise<void> {
  const jar = await cookies(), token = jar.get("elytra_session")?.value;
  if (token) deleteSession(token);
  jar.delete("elytra_session");
  refresh();
  redirect("/login");
}
export async function createPost(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  const saved: string[] = [];
  let id: string, release: (() => void) | undefined;
  try {
    release = await sharedCapacity("uploads", backendConfig().uploadConcurrency).acquire();
    if (!(formData instanceof FormData)) throw new Error("Invalid form");
    const content = text(formData, "content").trim(), replyToId = optionalId(formData, "replyToId"), quoteId = optionalId(formData, "quoteId");
    if ([...content].length > POST_MAX_LENGTH) throw new Error(`Posts can be at most ${POST_MAX_LENGTH} characters`);
    const entries = formData.getAll("images");
    if (entries.some(f => typeof f === "string")) throw new Error("Invalid image upload");
    const files = (entries as File[]).filter(f => f.size > 0);
    if (files.length > POST_MAX_IMAGES) throw new Error(`Add at most ${POST_MAX_IMAGES} images`);
    if (!content && !files.length && !quoteId) throw new Error("Write something or add an image");
    // Validate every image before writing the first one; clean up if any subsequent step fails.
    const images = await Promise.all(files.map(validateImage));
    for (const image of images) saved.push(await saveImage(image));
    id = await publishPost(viewer.id, { content, replyToId, quoteId, imageUrls: saved });
  } catch (error) { await removeImages(saved); return { ok: false, error: errorMessage(error) }; }
  finally { release?.(); }
  refresh();
  return { ok: true, data: { id } };
}
export async function deletePost(postId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  try {
    if (!validId(postId)) throw new Error("Invalid post ID");
    const images = removePost(viewer.id, postId);
    await removeImages(images);
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
  refresh();
  return { ok: true, data: undefined };
}
export async function toggleLike(postId: string): Promise<ActionResult<{ liked: boolean; likeCount: number }>> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  let result;
  try {
    if (!validId(postId)) throw new Error("Invalid post ID");
    result = togglePostInteraction(viewer.id, postId, "like");
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
  refresh();
  return { ok: true, data: { liked: result.active, likeCount: result.count } };
}
export async function toggleRepost(postId: string): Promise<ActionResult<{ reposted: boolean; repostCount: number }>> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  let result;
  try {
    if (!validId(postId)) throw new Error("Invalid post ID");
    result = togglePostInteraction(viewer.id, postId, "repost");
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
  refresh();
  return { ok: true, data: { reposted: result.active, repostCount: result.count } };
}
export async function toggleBookmark(postId: string): Promise<ActionResult<{ bookmarked: boolean }>> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  let active;
  try {
    if (!validId(postId)) throw new Error("Invalid post ID");
    active = togglePostInteraction(viewer.id, postId, "bookmark").active;
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
  refresh();
  return { ok: true, data: { bookmarked: active } };
}
export async function toggleFollow(userId: string): Promise<ActionResult<{ following: boolean }>> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  let following;
  try {
    if (!validId(userId)) throw new Error("Invalid user ID");
    following = toggleFollowUser(viewer.id, userId);
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
  refresh();
  return { ok: true, data: { following } };
}
export async function updateProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const viewer = await getViewer();
  if (!viewer) return { error: SIGN_IN_ERROR };
  if (!(formData instanceof FormData)) return { error: "Invalid form" };
  const displayName = text(formData, "displayName").trim(), bio = text(formData, "bio").trim(), location = text(formData, "location").trim();
  let website = text(formData, "website").trim();
  const fieldErrors: Record<string, string> = {};
  if (!displayName || displayName.length > 50) fieldErrors.displayName = "Display name must be 1–50 characters";
  if (bio.length > 160) fieldErrors.bio = "Bio must be at most 160 characters";
  if (location.length > 30) fieldErrors.location = "Location must be at most 30 characters";
  if (website) {
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(website)) website = `https://${website}`;
    try { const url = new URL(website); if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error(); }
    catch { fieldErrors.website = "Enter a valid http or https website"; }
    if (website.length > 100) fieldErrors.website = "Website must be at most 100 characters";
  }
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  const saved: string[] = [];
  let obsolete: string[] = [], release: (() => void) | undefined;
  try {
    release = await sharedCapacity("uploads", backendConfig().uploadConcurrency).acquire();
    const avatar = formData.get("avatar"), banner = formData.get("banner");
    if ((avatar !== null && !(avatar instanceof File)) || (banner !== null && !(banner instanceof File))) throw new Error("Invalid image upload");
    const avatarImage = avatar instanceof File && avatar.size > 0 ? await validateImage(avatar) : null;
    const bannerImage = banner instanceof File && banner.size > 0 ? await validateImage(banner) : null;
    let avatarUrl: string | undefined, bannerUrl: string | null | undefined;
    if (avatarImage) { avatarUrl = await saveImage(avatarImage); saved.push(avatarUrl); }
    if (text(formData, "removeBanner") === "1") bannerUrl = null;
    else if (bannerImage) { bannerUrl = await saveImage(bannerImage); saved.push(bannerUrl); }
    obsolete = editProfile(viewer.id, { displayName, bio, location, website, avatarUrl, bannerUrl });
  } catch (error) { await removeImages(saved); return { error: errorMessage(error) }; }
  finally { release?.(); }
  await removeImages(obsolete);
  pushProfileLater(viewer.id);
  refresh();
  return { success: true };
}
export async function updateAiOperated(value: boolean): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  try {
    if (typeof value !== "boolean") throw new Error("Invalid value");
    setAiOperated(viewer.id, value);
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
  refresh();
  return { ok: true, data: undefined };
}
export async function makeAgentToken(name: string, expiresInDays: number | null): Promise<ActionResult<AgentToken & { token: string }>> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  let created;
  try {
    if (typeof name !== "string" || (expiresInDays !== null && typeof expiresInDays !== "number")) throw new Error("Invalid token settings");
    created = createAgentToken(viewer.id, name, expiresInDays);
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
  return { ok: true, data: created };
}
export async function removeAgentToken(id: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  try {
    if (!validId(id)) throw new Error("Invalid token ID");
    revokeAgentToken(viewer.id, id);
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
  return { ok: true, data: undefined };
}
/** Onboarding's profile step: name, bio, and avatar. Keeps the location, website, and banner as they are. */
export async function saveOnboardingProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const viewer = await getViewer();
  if (!viewer) return { error: SIGN_IN_ERROR };
  if (!(formData instanceof FormData)) return { error: "Invalid form" };
  const displayName = text(formData, "displayName").trim(), bio = text(formData, "bio").trim();
  const fieldErrors: Record<string, string> = {};
  if (!displayName || [...displayName].length > 50) fieldErrors.displayName = "Display name must be 1–50 characters";
  if (bio.length > 160) fieldErrors.bio = "Bio must be at most 160 characters";
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  const current = profileByUsername(viewer.username, viewer.id);
  if (!current) return { error: SIGN_IN_ERROR };
  const saved: string[] = [];
  let obsolete: string[] = [], release: (() => void) | undefined;
  try {
    release = await sharedCapacity("uploads", backendConfig().uploadConcurrency).acquire();
    const avatar = formData.get("avatar");
    if (avatar !== null && !(avatar instanceof File)) throw new Error("Invalid image upload");
    let avatarUrl: string | undefined;
    if (avatar instanceof File && avatar.size > 0) { avatarUrl = await saveImage(await validateImage(avatar)); saved.push(avatarUrl); }
    obsolete = editProfile(viewer.id, { displayName, bio, location: current.location, website: current.website, avatarUrl });
  } catch (error) { await removeImages(saved); return { error: errorMessage(error) }; }
  finally { release?.(); }
  await removeImages(obsolete);
  pushProfileLater(viewer.id);
  refresh();
  return { success: true };
}
export async function markNotificationsRead(): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) return;
  readNotifications(viewer.id);
  refresh();
}
export async function fetchTimeline(source: TimelineSource, cursor: string | null): Promise<Page<FeedItem>> {
  if (!validTimelineSource(source) || (cursor !== null && (typeof cursor !== "string" || cursor.length > 500))) return { items: [], nextCursor: null };
  return getTimeline(source, cursor);
}

// ActionResult also exposes the standard signed-out error for telemetry callers.
export async function recordImpressions(postIds: string[]): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  try { saveImpressions(viewer.id, postIds); }
  catch (error) { return { ok: false, error: errorMessage(error) }; }
  // No revalidation: visibility telemetry must not refresh a scrolling timeline.
  return { ok: true, data: undefined };
}

export async function markNotInterested(postId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: SIGN_IN_ERROR };
  try { saveNotInterested(viewer.id, postId); }
  catch (error) { return { ok: false, error: errorMessage(error) }; }
  refresh();
  return { ok: true, data: undefined };
}
