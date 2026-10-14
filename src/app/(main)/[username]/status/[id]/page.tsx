import type { Metadata } from "next";
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
  return { title: `${post.author.displayName} on Elytra: "${text}"` };
}

export default async function StatusPage({ params }: PageProps<"/[username]/status/[id]">) {
  const { username, id } = await params;
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

      <div className="hidden border-b border-border px-4 py-1 sm:block">
        <Composer replyTo={post} compact />
      </div>

      {replies.map((reply) => (
        <PostCard key={reply.id} post={reply} showReplyContext={false} />
      ))}
    </>
  );
}
