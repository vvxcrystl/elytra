import { authorLine, postUrl, publicOrigin, statsLine } from "@/server/embed";
import { getPostThread } from "@/server/queries";

/**
 * oEmbed for post links. Discord reads author_name and provider_name from it,
 * which is how the author and the reply, repost, and like counts get on the embed.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  const thread = id && id.length <= 64 ? await getPostThread(id) : null;
  if (!thread) return Response.json({ error: "Post not found" }, { status: 404 });

  const { post } = thread;
  const origin = await publicOrigin();
  return Response.json(
    {
      version: "1.0",
      type: "link",
      author_name: authorLine(post),
      author_url: new URL(`/${post.author.username}`, origin).toString(),
      provider_name: `Elytra   ${statsLine(post)}`,
      provider_url: postUrl(post, origin),
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
