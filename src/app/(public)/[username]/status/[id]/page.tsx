import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { getViewer } from "@/server/auth";
import { notFound, redirect } from "next/navigation";
import { Composer } from "@/components/composer";
import { PageHeader } from "@/components/page-header";
import { PostCard } from "@/components/post-card";
import { UnavailablePost } from "@/components/quote-card";
import { getPostThread } from "@/server/queries";

export async function generateMetadata({
  params,
}: PageProps<"/[username]/status/[id]">): Promise<Metadata> {
  const { id } = await params;
  const thread = await getPostThread(id);
  if (!thread) return { title: "Post not found" };
  const { post } = thread;
  const text = post.content.length > 60 ? `${post.content.slice(0, 60)}…` : post.content;
  const title = `${post.author.displayName} on Elytra: "${text}"`;
  const description = post.content || `View @${post.author.username}'s post on Elytra.`;
  const requestHeaders = await headers();
  const origin = process.env.ELYTRA_PUBLIC_ORIGIN ||
    `${requestHeaders.get("x-forwarded-proto") || "http"}://${requestHeaders.get("host") || "localhost:3000"}`;
  const url = new URL(`/${post.author.username}/status/${post.id}`, origin).toString();
  const images = post.imageUrls.map((image) => new URL(image, origin).toString());
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "article", siteName: "Elytra", title, description, url, images },
    twitter: { card: images.length ? "summary_large_image" : "summary", title, description, images },
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
