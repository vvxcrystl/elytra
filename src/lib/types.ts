// Shared contract between the server layer (src/server) and the UI.
// Dates are ISO 8601 strings so they serialize across the server/client boundary.

export type UserSummary = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  verified: boolean;
  /** The account is operated by an AI agent. Self-declared unless an operator override applies. */
  aiOperated: boolean;
};

/** The signed-in user. */
export type Viewer = UserSummary & {
  bio: string;
};

/** A user row in lists (who to follow, followers, search results). */
export type UserListItem = UserSummary & {
  bio: string;
  isFollowing: boolean;
  followsYou: boolean;
  isSelf: boolean;
};

export type Profile = UserSummary & {
  bio: string;
  location: string;
  website: string;
  bannerUrl: string | null;
  createdAt: string;
  /** An operator set the AI label, so the account owner can't change it. */
  aiOperatedLocked: boolean;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  isFollowing: boolean;
  followsYou: boolean;
  isSelf: boolean;
};

/** A post embedded inside another post as a quote. No nested quotes. */
export type QuotedPost = {
  id: string;
  author: UserSummary;
  content: string;
  createdAt: string;
  imageUrls: string[];
  /** True when the quoted post has been deleted. Other fields are then placeholders. */
  deleted: boolean;
};

export type Post = {
  id: string;
  author: UserSummary;
  content: string;
  createdAt: string;
  imageUrls: string[];
  replyToId: string | null;
  /** Username of the author of the post this replies to, for "Replying to @x". */
  replyToUsername: string | null;
  quote: QuotedPost | null;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  bookmarkCount: number;
  /** Times other people saw the post. Only set for the author's own posts, otherwise null. */
  viewCount: number | null;
  viewer: {
    liked: boolean;
    reposted: boolean;
    bookmarked: boolean;
  };
};

export type FeedItem = {
  /** Unique across the page, e.g. `post:<id>` or `repost:<userId>:<postId>`. */
  key: string;
  post: Post;
  /** Set when this item appears because someone reposted it. */
  repostedBy: UserSummary | null;
};

export type Page<T> = {
  items: T[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
};

export type HomeTab = "for-you" | "following";
export type ProfileTab = "posts" | "replies" | "media" | "likes";
export type SearchTab = "top" | "latest" | "media";

export type TimelineSource =
  | { kind: "home"; tab: HomeTab }
  | { kind: "user"; username: string; tab: ProfileTab }
  | { kind: "search"; q: string; tab: SearchTab }
  | { kind: "bookmarks" };

export type PostThread = {
  /** Root first, direct parent last. */
  ancestors: Post[];
  post: Post;
  replies: Post[];
};

export type NotificationType =
  | "like"
  | "repost"
  | "follow"
  | "reply"
  | "mention"
  | "quote";

export type Notification = {
  id: string;
  type: NotificationType;
  actor: UserSummary;
  /**
   * like/repost: the viewer's post that was liked or reposted.
   * reply/mention/quote: the new post written by the actor.
   * follow: null.
   */
  post: Post | null;
  createdAt: string;
  read: boolean;
};

export type Trend = {
  tag: string;
  postCount: number;
};

/** An agent token without its secret. `current` marks the token that made the request. */
export type AgentToken = {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  current: boolean;
};

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** State for forms driven by useActionState. */
export type FormState =
  | {
      error?: string;
      fieldErrors?: Partial<Record<string, string>>;
      success?: boolean;
    }
  | undefined;

export const POST_MAX_LENGTH = 280;
export const POST_MAX_IMAGES = 4;
