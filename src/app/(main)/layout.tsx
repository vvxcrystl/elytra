import { ComposeProvider } from "@/components/compose-dialog";
import { NotificationProvider } from "@/components/notification-updates";
import { RightRail } from "@/components/right-rail";
import { MobileNav, SidebarNav } from "@/components/sidebar-nav";
import { ToastProvider } from "@/components/toast";
import { ViewerProvider } from "@/components/viewer-context";
import { requireViewer } from "@/server/auth";
import { getUnreadNotificationCount } from "@/server/queries";

export default async function MainLayout({ children }: LayoutProps<"/">) {
  const viewer = await requireViewer();
  const unread = await getUnreadNotificationCount();

  return (
    <ViewerProvider viewer={viewer}>
      <NotificationProvider initial={{ unread }}>
        <ToastProvider>
          <ComposeProvider>
            <div className="mx-auto flex min-h-dvh max-w-[1265px] justify-center sm:justify-start lg:justify-center">
              <aside className="hidden w-[88px] shrink-0 sm:block xl:w-[275px]">
                <SidebarNav />
              </aside>
              <main className="w-full max-w-[600px] min-w-0 border-border pb-16 sm:border-x sm:pb-0">
                {children}
              </main>
              <aside className="ml-7 hidden w-[350px] shrink-0 lg:block">
                <RightRail />
              </aside>
            </div>
            <MobileNav />
          </ComposeProvider>
        </ToastProvider>
      </NotificationProvider>
    </ViewerProvider>
  );
}
