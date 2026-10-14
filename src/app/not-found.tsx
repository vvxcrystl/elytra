import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[400px] px-8 py-24 text-center">
      <h1 className="text-[31px] font-extrabold">This page doesn&apos;t exist</h1>
      <p className="mt-2 text-[15px] text-fg-muted">Try searching for something else.</p>
      <Link href="/explore" className="btn-primary mt-7 h-10 px-6 text-[15px]">
        Search
      </Link>
    </div>
  );
}
