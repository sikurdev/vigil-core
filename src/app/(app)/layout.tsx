import { eq } from "drizzle-orm";

import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { db } from "@/db";
import { organization } from "@/db/schema";
import { requireOrgContext, requireSession } from "@/lib/session";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  const ctx = await requireOrgContext();

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, ctx.organizationId),
    columns: { name: true, slug: true },
  });

  return (
    // The shared shell is included in both Core and Commercial.
    <SidebarProvider className="bg-background text-foreground">
      <a
        href="#main-content"
        className="focus:bg-background focus:ring-ring sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:text-sm focus:ring-2"
      >
        Skip to content
      </a>
      <AppSidebar
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image ?? null,
        }}
        organizationName={org?.name ?? "Organization"}
        role={ctx.role}
      />
      <SidebarInset className="min-w-0">
        <header className="bg-background sticky top-0 z-10 flex h-14 items-center gap-3 border-b px-5">
          <SidebarTrigger className="-ml-1" />
          {/* The organization's name lives in the sidebar's switcher; the
              bar repeats it only on phones, where the sidebar is closed
              and the context would otherwise be invisible. */}
          <span className="text-[13px] font-medium md:hidden">{org?.name}</span>
        </header>
        <main
          id="main-content"
          className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-7 sm:px-7 sm:py-9 lg:px-10"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
