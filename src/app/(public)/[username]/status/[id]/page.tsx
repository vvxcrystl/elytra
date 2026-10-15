import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { getViewer } from "@/server/auth";
import { notFound, redirect } from "next/navigation";
import { Composer } from "@/components/composer";
import { PageHeader } from "@/components/page-header";
import { PostCard } from "@/components/post-card";
import { UnavailablePost } from "@/components/quote-card";
import { EMBED_COLOR, authorLine, embedDescription, embedImages, isCrawler, postUrl, publicOrigin } from "@/server/embed";
import { getPostThread } from "@/server/queries";

export async function generateViewport(): Promise<Viewport> {
  return (await isCrawler()) ? { themeColor: EMBED_COLOR } : {};
}

export async function generateMetadata({
  params,
}: PageProps<"/[username]/status/[id]">): Promise<Metadata> {
  const { id } = await params;
  const thread = await getPostThread(id);
  if (!thread) return { title: "Post not found" };
  const { post } = thread;
  const text = post.content.length > 60 ? `${post.content.slice(0, 60)}…` : post.content;
  const title = `${post.author.displayName} on Elytra: "${text}"`;
  const embedTitle = authorLine(post);
  const description = embedDescription(post);
  const origin = await publicOrigin();
  const url = postUrl(post, origin);
  const { images, large } = embedImages(post, origin);
  return {
    title,
    description,
    alternates: {
      canonical: url,
      types: { "application/json+oembed": new URL(`/api/oembed?id=${encodeURIComponent(post.id)}`, origin).toString() },
    },
    openGraph: {
      type: "article",
      siteName: "Elytra",
      title: embedTitle,
      description,
      url,
      images,
      publishedTime: post.createdAt,
      authors: [new URL(`/${post.author.username}`, origin).toString()],
    },
    twitter: { card: large ? "summary_large_image" : "summary", title: embedTitle, description, images },
  };
}

export default async function StatusPage({ params }: PageProps<"/[username]/status/[id]">) {
  const { username, id } = await params;
  const viewer = await getViewer();
  const thread = await getPostThread(id);
  if (!thread) notFound();

  const { ancestors, post, replies } = thread;
  if (post.author.username.toLowerCase() !== username.toLowerCase()) {
    redirect(`/${post.author.username}/status/${post.id}`);
  }

  // The parent exists in replyToId but the thread came back without it: it was deleted.
  const parentMissing = post.replyToId !== null && ancestors.length === 0;

  return (
    <>
      <PageHeader back title="Post" />

      {parentMissing && (
        <div className="px-4 pt-3">
          <UnavailablePost />
          <div className="ml-5 h-3 w-0.5 bg-border" />
        </div>
      )}

      {ancestors.map((ancestor) => (
        <PostCard
          key={ancestor.id}
          post={ancestor}
          variant="ancestor"
          showReplyContext={false}
          connectBelow
        />
      ))}

      <PostCard post={post} variant="detail" showReplyContext={ancestors.length === 0} />

      {viewer ? (
        <div className="hidden border-b border-border px-4 py-1 sm:block">
          <Composer replyTo={post} compact />
        </div>
      ) : (
        <div className="border-b border-border px-4 py-5">
          <p className="font-bold">Join the conversation</p>
          <p className="mt-1 text-[15px] text-fg-muted">Sign in to reply, like, and repost.</p>
          <div className="mt-3 flex gap-3">
            <Link href="/login" className="btn-primary px-5 py-2">Sign in</Link>
            <Link href="/signup" className="btn-outline px-5 py-2">Create account</Link>
          </div>
        </div>
      )}

      {replies.map((reply) => (
        <PostCard key={reply.id} post={reply} showReplyContext={false} />
      ))}
    </>
  );
}
