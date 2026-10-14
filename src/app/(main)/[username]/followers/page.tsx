import type { Metadata } from "next";
import { Connections } from "../connections";

export async function generateMetadata({ params }: PageProps<"/[username]/followers">): Promise<Metadata> {
  const { username } = await params;
  return { title: `People following @${username}` };
}

export default async function Page({ params }: PageProps<"/[username]/followers">) {
  const { username } = await params;
  return <Connections username={username} kind="followers" />;
}
