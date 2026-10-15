import "server-only";
import type { AgentToken, FeedItem, Page, TimelineSource, PostThread, Post, Profile, UserListItem, Trend, Notification } from "@/lib/types";
import { getViewer } from "./auth";
import { timeline } from "./data/timeline";
import { postById, postThread } from "./data/posts";
import { listAgentTokens } from "./data/agent-tokens";
import { profileByUsername, followersOf, findUsers, suggestedUsers, trends, notificationsFor, unreadCount } from "./data/people";

const viewerId = async () => (await getViewer())?.id || null;
export async function getTimeline(source: TimelineSource, cursor?: string | null): Promise<Page<FeedItem>> { return timeline(source, cursor, await viewerId()); }
export async function getPostThread(id: string): Promise<PostThread | null> { return postThread(id, await viewerId()); }
export async function getPost(id: string): Promise<Post | null> { return postById(id, await viewerId()); }
export async function getProfile(username: string): Promise<Profile | null> { return profileByUsername(username, await viewerId()); }
export async function getFollowers(username: string): Promise<UserListItem[]> { return followersOf(username, await viewerId(), "followers"); }
export async function getFollowing(username: string): Promise<UserListItem[]> { return followersOf(username, await viewerId(), "following"); }
export async function searchUsers(q: string, limit = 20): Promise<UserListItem[]> { return findUsers(q, limit, await viewerId()); }
export async function getWhoToFollow(limit = 3): Promise<UserListItem[]> { return suggestedUsers(limit, await viewerId()); }
export async function getTrends(limit = 5): Promise<Trend[]> { await getViewer(); return trends(limit); }
export async function getNotifications(opts?: { mentionsOnly?: boolean }): Promise<Notification[]> { return notificationsFor(await viewerId(), opts?.mentionsOnly); }
export async function getUnreadNotificationCount(): Promise<number> { return unreadCount(await viewerId()); }
export async function getAgentTokens(): Promise<AgentToken[]> { const id = await viewerId(); return id ? listAgentTokens(id, null) : []; }
