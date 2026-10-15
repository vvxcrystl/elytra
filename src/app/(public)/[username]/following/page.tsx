import type { Metadata } from "next";
import { Connections } from "../connections";

export async function generateMetadata({ params }: PageProps<"/[username]/following">): Promise<Metadata> {
  const { username } = await params;
  return { title: `People followed by @${username}` };
}

export default async function Page({ params }: PageProps<"/[username]/following">) {
  const { username } = await params;
  return <Connections username={username} kind="following" />;
}
