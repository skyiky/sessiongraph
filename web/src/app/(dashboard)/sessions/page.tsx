import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { History } from "lucide-react";
import { SessionsTable } from "@/components/sessions-table";
import { Skeleton } from "@/components/ui/skeleton";
import type { Session } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sessions",
  description: "Browse and explore your AI coding sessions.",
};

const VALID_SORT_COLUMNS = [
  "project",
  "tool",
  "started_at",
  "duration",
  "chains",
] as const;
type SortColumn = (typeof VALID_SORT_COLUMNS)[number];

function isValidSortColumn(value: string): value is SortColumn {
  return (VALID_SORT_COLUMNS as readonly string[]).includes(value);
}

function isValidOrder(value: string): value is "asc" | "desc" {
  return value === "asc" || value === "desc";
}

// Map our sort columns to Supabase column names
function getSupabaseSort(sort: SortColumn): string | null {
  switch (sort) {
    case "project":
      return "project";
    case "tool":
      return "tool";
    case "started_at":
      return "started_at";
    // duration and chains require client-side sorting
    default:
      return null;
  }
}

function getDurationMs(session: Session): number {
  if (!session.ended_at) return Infinity;
  return new Date(session.ended_at).getTime() - new Date(session.started_at).getTime();
}

function getChainCount(session: Session): number {
  if (!session.reasoning_chains || session.reasoning_chains.length === 0) return 0;
  return session.reasoning_chains[0].count;
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const sortParam = typeof params.sort === "string" ? params.sort : "started_at";
  const orderParam = typeof params.order === "string" ? params.order : "desc";
  const projectParam = typeof params.project === "string" ? params.project : "";

  const sort: SortColumn = isValidSortColumn(sortParam) ? sortParam : "started_at";
  const order: "asc" | "desc" = isValidOrder(orderParam) ? orderParam : "desc";

  const supabase = await createClient();

  // Build query
  let query = supabase
    .from("sessions")
    .select("*, reasoning_chains(count)");

  if (projectParam) {
    query = query.eq("project", projectParam);
  }

  // Apply server-side sort if the column maps directly to a DB column
  const supabaseColumn = getSupabaseSort(sort);
  if (supabaseColumn) {
    query = query.order(supabaseColumn, { ascending: order === "asc" });
  } else {
    // For computed sorts, fetch in default order and sort client-side
    query = query.order("started_at", { ascending: false });
  }

  query = query.limit(50);

  // Fetch sessions and unique projects in parallel
  const [{ data: sessionsData }, { data: projectsData }] = await Promise.all([
    query,
    supabase.from("sessions").select("project"),
  ]);

  let sessions = (sessionsData ?? []) as Session[];

  // Client-side sorting for computed columns
  if (sort === "duration") {
    sessions = [...sessions].sort((a, b) => {
      const aDur = getDurationMs(a);
      const bDur = getDurationMs(b);
      return order === "asc" ? aDur - bDur : bDur - aDur;
    });
  } else if (sort === "chains") {
    sessions = [...sessions].sort((a, b) => {
      const aCount = getChainCount(a);
      const bCount = getChainCount(b);
      return order === "asc" ? aCount - bCount : bCount - aCount;
    });
  }

  const projects = [
    ...new Set(
      projectsData?.filter((s) => s.project).map((s) => s.project as string)
    ),
  ].sort();

  const totalCount = projectParam
    ? sessionsData?.length ?? 0
    : projectsData?.length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <History className="size-5 text-muted-foreground" />
          <h1 className="font-mono text-2xl font-bold tracking-tight">
            Sessions
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {totalCount} {totalCount === 1 ? "session" : "sessions"} recorded
          {projectParam && (
            <span>
              {" "}
              in <span className="font-mono">{projectParam}</span>
            </span>
          )}
        </p>
      </div>

      {/* Table */}
      <Suspense
        fallback={
          <div className="space-y-3">
            <Skeleton className="h-9 w-[200px]" />
            <Skeleton className="h-[400px] w-full" />
          </div>
        }
      >
        <SessionsTable
          sessions={sessions}
          projects={projects}
          currentSort={sort}
          currentOrder={order}
          currentProject={projectParam}
        />
      </Suspense>
    </div>
  );
}
