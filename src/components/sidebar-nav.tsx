"use client";

import clsx from "clsx";
import {
  Bell,
  Bookmark,
  Feather,
  Home,
  LogOut,
  Mail,
  Monitor,
  Moon,
  MoreHorizontal,
  Search,
  Sun,
  User,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "@/server/actions";
import { Avatar } from "./avatar";
import { useCompose } from "./compose-dialog";
import { Logo } from "./logo";
import { Menu } from "./menu";
import { useUnreadMessageCount } from "./messages/polling";
import { useUnreadNotificationCount } from "./notification-updates";
import { useTheme } from "./theme";
import { VerifiedBadge } from "./verified-badge";
import { useViewer } from "./viewer-context";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
  badge?: number;
  match: (path: string) => boolean;
};

function useNavItems(): NavItem[] {
  const viewer = useViewer();
  const unread = useUnreadNotificationCount();
  const unreadMessages = useUnreadMessageCount();
  const profile = `/${viewer.username}`;
  return [
    { href: "/home", label: "Home", icon: Home, match: (p) => p === "/home" },
    { href: "/explore", label: "Explore", icon: Search, match: (p) => p.startsWith("/explore") },
    {
      href: "/notifications",
      label: "Notifications",
      icon: Bell,
      badge: unread,
      match: (p) => p.startsWith("/notifications"),
    },
    {
      href: "/messages",
      label: "Messages",
      icon: Mail,
      badge: unreadMessages,
      match: (p) => p === "/messages" || p.startsWith("/messages/"),
    },
    { href: "/bookmarks", label: "Bookmarks", icon: Bookmark, match: (p) => p === "/bookmarks" },
    {
      href: profile,
      label: "Profile",
      icon: User,
      match: (p) => {
        const path = p.toLowerCase();
        const base = profile.toLowerCase();
        return path === base || (path.startsWith(`${base}/`) && !path.includes("/status/"));
      },
    },
  ];
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute -top-1.5 -right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-fg ring-2 ring-bg">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const items = useNavItems();
  const openCompose = useCompose();

  return (
    <div className="sticky top-0 flex h-dvh flex-col justify-between px-2 py-1 xl:px-3">
      <div className="flex flex-col items-center xl:items-stretch">
        <Link
          href="/home"
          aria-label="Elytra home"
          className="mb-1 flex size-[52px] items-center justify-center rounded-full transition-colors hover:bg-bg-hover"
        >
          <Logo className="size-8" />
        </Link>
        <nav className="flex flex-col items-center gap-0.5 xl:items-stretch" aria-label="Primary">
          {items.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.label}
                href={item.href}
                aria-current={active ? "page" : undefined}
                title={item.label}
                className="group flex py-0.5"
              >
                <span className="flex items-center gap-5 rounded-full p-3 transition-colors group-hover:bg-bg-hover xl:pr-6">
                  <span className="relative">
                    <Icon className="size-[26px]" strokeWidth={active ? 2.5 : 1.75} />
                    {item.badge !== undefined && <Badge count={item.badge} />}
                  </span>
                  <span className={clsx("hidden text-xl xl:inline", active ? "font-bold" : "font-normal")}>
                    {item.label}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={() => openCompose()}
          className="btn-primary mt-4 size-[52px] text-[17px] xl:h-[52px] xl:w-[90%]"
        >
          <Feather className="size-6 xl:hidden" />
          <span className="hidden xl:inline">Post</span>
        </button>
      </div>
      <AccountMenu />
    </div>
  );
}

function useAccountMenuItems() {
  const viewer = useViewer();
  const { theme, setTheme } = useTheme();

  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const themeLabel = {
    system: "Use system theme",
    light: "Switch to light theme",
    dark: "Switch to dark theme",
  }[next];
  const ThemeIcon = { system: Monitor, light: Sun, dark: Moon }[next];

  return [
    {
      label: themeLabel,
      icon: <ThemeIcon className="size-[18px]" />,
      onSelect: () => setTheme(next),
    },
    {
      label: `Log out @${viewer.username}`,
      icon: <LogOut className="size-[18px]" />,
      onSelect: () => signOut(),
    },
  ];
}

function AccountMenu() {
  const viewer = useViewer();
  const items = useAccountMenuItems();

  return (
    <div className="mb-3 flex justify-center xl:block">
      <Menu
        label="Account"
        align="left"
        side="top"
        items={items}
        trigger={({ toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-label="Account menu"
            className="flex w-full items-center gap-3 rounded-full p-3 text-left transition-colors hover:bg-bg-hover"
          >
            <Avatar user={viewer} />
            <span className="hidden min-w-0 flex-1 leading-5 xl:block">
              <span className="block truncate text-[15px] font-bold">
                {viewer.displayName}
                <VerifiedBadge user={viewer} className="ml-1" />
              </span>
              <span className="block truncate text-[15px] text-fg-muted">@{viewer.username}</span>
            </span>
            <MoreHorizontal className="hidden size-5 xl:block" />
          </button>
        )}
      />
    </div>
  );
}

/** Avatar + logo bar shown above the Home tabs on small screens. */
export function MobileTopBar() {
  const router = useRouter();
  const viewer = useViewer();
  const items = useAccountMenuItems();

  return (
    <div className="relative flex h-[53px] items-center justify-center px-4 sm:hidden">
      <div className="absolute left-4">
        <Menu
          label="Account"
          align="left"
          items={[
            {
              label: "Profile",
              icon: <User className="size-[18px]" />,
              onSelect: () => router.push(`/${viewer.username}`),
            },
            ...items,
          ]}
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} aria-label="Account menu" className="flex rounded-full">
              <Avatar user={viewer} size="sm" />
            </button>
          )}
        />
      </div>
      <Logo className="size-7" />
    </div>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const items = useNavItems();
  const openCompose = useCompose();

  // An open conversation takes the full screen, with its composer where the tab bar would be.
  const inConversation = /^\/messages\/(?!new$)[^/]+$/.test(pathname);
  if (inConversation) return null;
  // The inbox shows its own new-message button in place of the post button.
  const showPostButton = !pathname.startsWith("/messages");

  return (
    <>
      {showPostButton && (
        <button
          type="button"
          onClick={() => openCompose()}
          aria-label="New post"
          className="btn-primary fixed right-4 bottom-20 z-30 size-14 shadow-lg sm:hidden"
        >
          <Feather className="size-6" />
        </button>
      )}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex h-[53px] items-center justify-around border-t border-border bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden"
      >
        {items.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              href={item.href}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "flex flex-1 justify-center py-3 transition-colors",
                active ? "text-fg" : "text-fg-muted",
              )}
            >
              <span className="relative">
                <Icon className="size-[26px]" strokeWidth={active ? 2.5 : 1.75} />
                {item.badge !== undefined && <Badge count={item.badge} />}
              </span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
