import Link from "next/link";
import { ArrowLeft, Clock, GitBranch, MessageSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ChainCard } from "@/components/chain-card";
import { ConversationView } from "@/components/conversation-view";
import type { ReasoningChain, SessionChunk } from "@/lib/types";

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "In progress";

  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const diffMs = end - start;

  if (diffMs < 0) return "—";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: session },
    { data: chains },
    { data: chunks },
  ] = await Promise.all([
    supabase.from("sessions").select("*").eq("id", id).single(),
    supabase
      .from("reasoning_chains")
      .select("*")
      .eq("session_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("session_chunks")
      .select("*")
      .eq("session_id", id)
      .order("chunk_index", { ascending: true }),
  ]);

  if (!session) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <Link
          href="/sessions"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sessions
        </Link>
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <h2 className="font-mono text-lg font-semibold text-foreground">
            Session not found
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The session you&apos;re looking for doesn&apos;t exist or you don&apos;t have
            access to it.
          </p>
        </div>
      </div>
    );
  }

  const reasoningChains = (chains ?? []) as ReasoningChain[];
  const sessionChunks = (chunks ?? []) as SessionChunk[];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {/* Back link */}
      <Link
        href="/sessions"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to sessions
      </Link>

      {/* Session header card */}
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-xl tracking-tight">
            {session.project ?? "Untitled Project"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary" className="font-mono text-xs">
              {session.tool}
            </Badge>
            {!session.ended_at && (
              <Badge variant="outline" className="gap-1 text-xs text-green-500 border-green-500/30">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                Active
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="h-4 w-4 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground/70">Started</p>
                <p className="text-foreground">{formatDate(session.started_at)}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="h-4 w-4 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground/70">
                  {session.ended_at ? "Ended" : "Status"}
                </p>
                <p className="text-foreground">
                  {session.ended_at ? formatDate(session.ended_at) : "In progress"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="h-4 w-4 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground/70">Duration</p>
                <p className="font-mono text-foreground">
                  {formatDuration(session.started_at, session.ended_at)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-muted-foreground">
              <GitBranch className="h-4 w-4 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground/70">Chains</p>
                <p className="font-mono text-foreground">{reasoningChains.length}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      {session.summary && (
        <section className="space-y-3">
          <h2 className="font-mono text-lg font-semibold tracking-tight">
            Summary
          </h2>
          <Card>
            <CardContent className="py-0">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {session.summary}
              </p>
            </CardContent>
          </Card>
        </section>
      )}

      <Separator />

      {/* Reasoning chains */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <GitBranch className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-mono text-lg font-semibold tracking-tight">
            Reasoning Chains
          </h2>
          <Badge variant="secondary" className="font-mono text-xs">
            {reasoningChains.length}
          </Badge>
        </div>

        {reasoningChains.length > 0 ? (
          <div className="grid grid-cols-1 gap-4">
            {reasoningChains.map((chain) => (
              <ChainCard
                key={chain.id}
                chain={chain}
                truncate={false}
                hideSessionLink
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No reasoning chains extracted from this session yet.
            </p>
          </div>
        )}
      </section>

      <Separator />

      {/* Raw conversation */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-mono text-lg font-semibold tracking-tight">
            Conversation
          </h2>
          <Badge variant="secondary" className="font-mono text-xs">
            {sessionChunks.length}
          </Badge>
        </div>

        <ConversationView chunks={sessionChunks} />
      </section>
    </div>
  );
}
