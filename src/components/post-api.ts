import type { ActionResult } from "@/lib/types";

/** The route handler invalidates future visits without reranking the open feed. */
export async function setPostLiked(
  postId: string,
  liked: boolean,
): Promise<ActionResult<{ liked: boolean; likeCount: number }>> {
  try {
    const response = await fetch(`/api/v1/posts/${encodeURIComponent(postId)}/like`, {
      method: liked ? "PUT" : "DELETE",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const body = await response.json();
    if (!response.ok || !body.data) {
      return { ok: false, error: body.error?.message ?? "Couldn't update your like. Try again." };
    }
    return { ok: true, data: { liked: body.data.active, likeCount: body.data.count } };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection." };
  }
}

export type PostAnalytics = {
  impressions: number;
  engagements: number;
  detailExpands: number;
  profileVisits: number;
  replies: number;
  reposts: number;
  likes: number;
  bookmarks: number;
};

/** Fire and forget. `keepalive` lets the request finish while a link navigates away. */
export function recordPostVisit(postId: string, kind: "detail" | "profile"): void {
  void fetch(`/api/v1/posts/${encodeURIComponent(postId)}/visits`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    keepalive: true,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ kind }),
  }).catch(() => {});
}

export async function fetchPostAnalytics(postId: string): Promise<ActionResult<PostAnalytics>> {
  try {
    const response = await fetch(`/api/v1/posts/${encodeURIComponent(postId)}/analytics`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const body = await response.json();
    if (!response.ok || !body.data) return { ok: false, error: body.error?.message ?? "Couldn't load analytics." };
    return { ok: true, data: body.data };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection." };
  }
}
