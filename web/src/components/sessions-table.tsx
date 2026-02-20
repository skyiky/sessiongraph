"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowUpDown, ArrowUp, ArrowDown, History } from "lucide-react";
import type { Session } from "@/lib/types";

type SortColumn = "project" | "tool" | "started_at" | "duration" | "chains";

interface SessionsTableProps {
  sessions: Session[];
  projects: string[];
  currentSort: string;
  currentOrder: string;
  currentProject: string;
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "ongoing";

  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const diffMs = end - start;

  if (diffMs < 0) return "—";

  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "< 1m";
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getChainCount(session: Session): number {
  if (!session.reasoning_chains || session.reasoning_chains.length === 0)
    return 0;
  return session.reasoning_chains[0].count;
}

function SortableHeader({
  column,
  label,
  currentSort,
  currentOrder,
  onSort,
}: {
  column: SortColumn;
  label: string;
  currentSort: string;
  currentOrder: string;
  onSort: (column: SortColumn) => void;
}) {
  const isActive = currentSort === column;

  return (
    <button
      onClick={() => onSort(column)}
      className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors -ml-2 px-2 py-1 rounded-md hover:bg-accent/50"
    >
      {label}
      {isActive ? (
        currentOrder === "asc" ? (
          <ArrowUp className="size-3.5" />
        ) : (
          <ArrowDown className="size-3.5" />
        )
      ) : (
        <ArrowUpDown className="size-3.5 opacity-40" />
      )}
    </button>
  );
}

export function SessionsTable({
  sessions,
  projects,
  currentSort,
  currentOrder,
  currentProject,
}: SessionsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const createQueryString = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      return params.toString();
    },
    [searchParams]
  );

  const handleSort = useCallback(
    (column: SortColumn) => {
      const newOrder =
        currentSort === column && currentOrder === "desc" ? "asc" : "desc";
      const qs = createQueryString({ sort: column, order: newOrder });
      router.push(`${pathname}?${qs}`);
    },
    [currentSort, currentOrder, createQueryString, router, pathname]
  );

  const handleProjectFilter = useCallback(
    (value: string) => {
      const qs = createQueryString({
        project: value === "all" ? null : value,
      });
      router.push(`${pathname}?${qs}`);
    },
    [createQueryString, router, pathname]
  );

  const handleRowClick = useCallback(
    (sessionId: string) => {
      router.push(`/sessions/${sessionId}`);
    },
    [router]
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select
          value={currentProject || "all"}
          onValueChange={handleProjectFilter}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project} value={project}>
                <span className="font-mono">{project}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <History className="mx-auto mb-3 size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            No sessions found.
          </p>
          {currentProject && (
            <p className="mt-1 text-xs text-muted-foreground/70">
              Try clearing the project filter.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>
                  <SortableHeader
                    column="project"
                    label="Project"
                    currentSort={currentSort}
                    currentOrder={currentOrder}
                    onSort={handleSort}
                  />
                </TableHead>
                <TableHead>
                  <SortableHeader
                    column="tool"
                    label="Tool"
                    currentSort={currentSort}
                    currentOrder={currentOrder}
                    onSort={handleSort}
                  />
                </TableHead>
                <TableHead>
                  <SortableHeader
                    column="started_at"
                    label="Started"
                    currentSort={currentSort}
                    currentOrder={currentOrder}
                    onSort={handleSort}
                  />
                </TableHead>
                <TableHead>
                  <SortableHeader
                    column="duration"
                    label="Duration"
                    currentSort={currentSort}
                    currentOrder={currentOrder}
                    onSort={handleSort}
                  />
                </TableHead>
                <TableHead>
                  <SortableHeader
                    column="chains"
                    label="Chains"
                    currentSort={currentSort}
                    currentOrder={currentOrder}
                    onSort={handleSort}
                  />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow
                  key={session.id}
                  onClick={() => handleRowClick(session.id)}
                  className="hover:bg-accent/50 cursor-pointer transition-colors"
                >
                  <TableCell className="font-mono text-sm">
                    {session.project ?? (
                      <span className="text-muted-foreground">&mdash;</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{session.tool}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(session.started_at)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDuration(session.started_at, session.ended_at)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{getChainCount(session)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
