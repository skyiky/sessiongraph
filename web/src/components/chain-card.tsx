import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { cn } from "@/lib/utils";
import type { ReasoningChain } from "@/lib/types";

function timeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function ChainCard({
  chain,
  showSimilarity = false,
  truncate = true,
  hideSessionLink = false,
  className,
}: {
  chain: ReasoningChain;
  showSimilarity?: boolean;
  truncate?: boolean;
  hideSessionLink?: boolean;
  className?: string;
}) {
  const content = truncate && chain.content.length > 200
    ? chain.content.slice(0, 200) + "..."
    : chain.content;

  return (
    <Card className={cn("transition-colors hover:border-primary/30", className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <ChainTypeBadge type={chain.type} />
          {showSimilarity && chain.similarity !== undefined && (
            <Badge variant="secondary" className="font-mono text-xs">
              {Math.round(chain.similarity * 100)}% match
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {timeAgo(chain.created_at)}
        </span>
      </CardHeader>
      <CardContent className="space-y-2">
        <h3 className="font-mono text-sm font-semibold leading-tight text-foreground">
          {chain.title}
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {content}
        </p>
        {chain.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {chain.tags.map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="text-xs font-normal"
              >
                {tag}
              </Badge>
            ))}
          </div>
        )}
        {chain.session_id && !hideSessionLink && (
          <div className="pt-1">
            <Link
              href={`/sessions/${chain.session_id}`}
              className="text-xs text-primary hover:underline"
            >
              View session →
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
