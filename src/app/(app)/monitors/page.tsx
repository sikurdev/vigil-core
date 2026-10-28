import { PulseIcon } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";

import { MonitorStatusIndicator } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Empty,
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
import { formatDuration, formatRelativeTime, formatUptime } from "@/lib/format";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { listMonitors } from "@/modules/monitors/service";

import { CreateMonitorDialog } from "./create-monitor-dialog";
import { MonitorRowActions } from "./monitor-row-actions";

export const metadata: Metadata = { title: "Monitors · Vigil" };

export default async function MonitorsPage() {
  const ctx = await requireOrgContext();
  const monitors = await listMonitors(db, ctx.organizationId);

  const canCreate = hasPermission(ctx.role, { monitor: ["create"] });
  const canUpdate = hasPermission(ctx.role, { monitor: ["update"] });
  const canDelete = hasPermission(ctx.role, { monitor: ["delete"] });

  const hasPending = monitors.some(
    (monitor) => monitor.currentStatus === "unknown" && !monitor.paused,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">Monitors</h1>
            <Badge variant="secondary" className="font-mono tabular-nums">
              {monitors.length}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            Checks that watch your endpoints and open incidents when they fail.
          </p>
        </div>
        {canCreate && (
          <CreateMonitorDialog
          />
        )}
      </div>

      {monitors.length === 0 ? (
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PulseIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No monitors yet</EmptyTitle>
            <EmptyDescription>
              Create your first monitor to start tracking uptime and response
              times. The first check runs within a minute.
            </EmptyDescription>
          </EmptyHeader>
          {canCreate && (
            <CreateMonitorDialog
            />
          )}
        </Empty>
      ) : (
        <>
          <Card className="gap-0 py-0">
            <Table>
              <TableHeader>
                {/* Small screens keep status, name and uptime. Response time,
                    freshness and target detail return as the workspace widens. */}
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10 pl-4 sm:w-32">
                    <span className="max-sm:sr-only">Status</span>
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden 2xl:table-cell">URL</TableHead>
                  <TableHead className="text-right">
                    Uptime<span className="hidden sm:inline"> · 24h</span>
                  </TableHead>
                  <TableHead className="hidden text-right lg:table-cell">
                    Avg response
                  </TableHead>
                  <TableHead className="hidden text-right 2xl:table-cell">
                    Interval
                  </TableHead>
                  <TableHead className="hidden text-right xl:table-cell">
                    Last checked
                  </TableHead>
                  <TableHead className="w-12 pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {monitors.map((monitor) => (
                  <TableRow key={monitor.id}>
                    <TableCell className="pl-4">
                      <MonitorStatusIndicator
                        status={monitor.currentStatus}
                        paused={monitor.paused}
                        className="text-xs"
                        compactLabel
                      />
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/monitors/${monitor.id}`}
                        className="block max-w-[35vw] truncate font-medium hover:underline sm:max-w-56"
                      >
                        {monitor.name}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden 2xl:table-cell">
                      <span className="text-muted-foreground block max-w-56 truncate font-mono">
                        {monitor.url}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatUptime(monitor.uptime24hPct)}
                    </TableCell>
                    <TableCell className="hidden text-right font-mono tabular-nums lg:table-cell">
                      {monitor.avgResponseMs === null
                        ? "-"
                        : formatDuration(monitor.avgResponseMs)}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-right font-mono tabular-nums 2xl:table-cell">
                      {formatDuration(monitor.intervalSeconds * 1000)}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-right xl:table-cell">
                      {monitor.lastCheckedAt
                        ? formatRelativeTime(monitor.lastCheckedAt)
                        : "-"}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {(canUpdate || canDelete) && (
                        <MonitorRowActions
                          monitorId={monitor.id}
                          monitorName={monitor.name}
                          paused={monitor.paused}
                          canUpdate={canUpdate}
                          canDelete={canDelete}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          {hasPending && (
            <p className="text-muted-foreground text-xs">
              Monitors marked Pending run their first check within a minute.
            </p>
          )}
        </>
      )}
    </div>
  );
}
