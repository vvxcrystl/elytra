export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[400px] px-8 py-12">
      <h2 className="text-[31px] leading-9 font-extrabold">{title}</h2>
      {body && <p className="mt-2 text-[15px] text-fg-muted">{body}</p>}
      {action && <div className="mt-7">{action}</div>}
    </div>
  );
}
