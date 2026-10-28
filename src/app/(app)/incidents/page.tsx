import type { Metadata } from "next";
import Link from "next/link";

import {
  CheckCircleIcon,
  PulseIcon,
  SirenIcon,
  UserIcon,
} from "@phosphor-icons/react/dist/ssr";

import { IncidentStatusBadge, SeverityBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/db";
import {
  formatDateTime,
  formatDuration,
  formatRelativeTime,
} from "@/lib/format";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { cn } from "@/lib/utils";
import { isActiveStatus } from "@/modules/incidents/lifecycle";
import {
  listIncidents,
  type IncidentListItem,
} from "@/modules/incidents/service";

import { CreateIncidentDialog } from "./create-incident-dialog";

export const metadata: Metadata = { title: "Incidents · Vigil" };

export default async function IncidentsPage(props: PageProps<"/incidents">) {
  const ctx = await requireOrgContext();
  const searchParams = await props.searchParams;
  const tab = searchParams.tab === "all" ? "all" : "active";

  const incidents = await listIncidents(db, ctx.organizationId);
  const activeIncidents = incidents.filter((incident) =>
    isActiveStatus(incident.status),
  );
  const rows = tab === "all" ? incidents : activeIncidents;
  const canCreate = hasPermission(ctx.role, { incident: ["create"] });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">Incidents</h1>
            <Badge
              variant="secondary"
              className={cn(
                "font-mono",
                activeIncidents.length > 0 && "text-destructive",
              )}
            >
              {activeIncidents.length} open
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            Track, coordinate and resolve service disruptions.
          </p>
        </div>
        {canCreate && <CreateIncidentDialog />}
      </div>

      <nav
        aria-label="Incident views"
        className="bg-card flex w-fit gap-1 rounded-md border p-1"
      >
        {[
          { value: "active", label: "Active", href: "/incidents" },
          { value: "all", label: "All", href: "/incidents?tab=all" },
        ].map((view) => (
          <Link
            key={view.value}
            href={view.href}
            aria-current={tab === view.value ? "page" : undefined}
            className={cn(
              "focus-visible:outline-ring inline-flex min-h-9 items-center rounded-sm px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 max-sm:min-h-11",
              tab === view.value
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {view.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        tab === "active" ? (
          <Empty className="border border-dashed py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="text-muted-foreground">
                <CheckCircleIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No active incidents</EmptyTitle>
              <EmptyDescription>
                All systems operational. New incidents will appear here the
                moment they open.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Empty className="border border-dashed py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SirenIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No incidents yet</EmptyTitle>
              <EmptyDescription>
                When something breaks (or you report it). The full history will
                live here.
              </EmptyDescription>
            </EmptyHeader>
            {canCreate && (
              <EmptyContent>
                <CreateIncidentDialog />
              </EmptyContent>
            )}
          </Empty>
        )
      ) : (
        <div className="ring-foreground/10 overflow-hidden ring-1">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-24 pl-4">Severity</TableHead>
                <TableHead>Incident</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-44">Source</TableHead>
                <TableHead className="w-32">Started</TableHead>
                <TableHead className="w-28 pr-4 text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((incident) => (
                <IncidentRow key={incident.id} incident={incident} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function IncidentRow({ incident }: { incident: IncidentListItem }) {
  return (
    <TableRow>
      <TableCell className="pl-4">
        <SeverityBadge severity={incident.severity} />
      </TableCell>
      <TableCell className="max-w-80 truncate font-medium">
        <Link
          href={`/incidents/${incident.id}`}
          className="underline-offset-4 hover:underline"
        >
          {incident.title}
        </Link>
      </TableCell>
      <TableCell>
        <IncidentStatusBadge status={incident.status} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {incident.source === "monitor" ? (
          <span className="flex items-center gap-1.5">
            <PulseIcon className="size-3.5" aria-hidden />
            {incident.monitorName ?? "Monitor"}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <UserIcon className="size-3.5" aria-hidden />
            Manual
          </span>
        )}
      </TableCell>
      <TableCell
        className="text-muted-foreground"
        title={formatDateTime(incident.startedAt)}
      >
        {formatRelativeTime(incident.startedAt)}
      </TableCell>
      <TableCell className="pr-4 text-right font-mono">
        {incident.resolvedAt ? (
          formatDuration(
            incident.resolvedAt.getTime() - incident.startedAt.getTime(),
          )
        ) : (
          <span className="text-muted-foreground">ongoing</span>
        )}
      </TableCell>
    </TableRow>
  );
}
