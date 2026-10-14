const ORB = "absolute rounded-full blur-3xl motion-safe:animate-[orb-drift_24s_ease-in-out_infinite]";

/** Frosted card that sits on the backdrop. */
export const GLASS_CARD =
  "rounded-3xl border border-accent/20 bg-bg/70 shadow-2xl shadow-black/20 backdrop-blur-xl dark:border-white/10 dark:bg-bg/80 dark:shadow-black/50";

/** Full-screen layer of blurred violet circles, used behind the auth and onboarding cards. */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-bg">
      <div className={`${ORB} top-1/2 left-1/2 size-[min(900px,120vw)] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(circle,var(--orb-1)_0%,transparent_65%)]`} />
      <div className={`${ORB} -top-[15%] -left-[10%] size-[min(640px,90vw)] [animation-delay:-8s] bg-[radial-gradient(circle,var(--orb-2)_0%,transparent_70%)]`} />
      <div className={`${ORB} -right-[10%] -bottom-[20%] size-[min(700px,95vw)] [animation-delay:-16s] bg-[radial-gradient(circle,var(--orb-3)_0%,transparent_70%)]`} />
      {/* Faint ring traced around the centre circle. */}
      <div className="absolute top-1/2 left-1/2 size-[min(760px,110vw)] -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent/15 dark:border-accent/10" />
    </div>
  );
}
