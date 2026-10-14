import { SectionHeading } from "@/components/section";

/** A titled group on the settings page. Put new settings inside one as rows or other content. */
export function SettingsSection({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-border pb-2">
      <SectionHeading>{title}</SectionHeading>
      {children}
    </section>
  );
}

/** Label and description on the left, an optional control such as a button or toggle on the right. */
export function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-bold">{title}</p>
        {description && <p className="text-[13px] text-fg-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}
