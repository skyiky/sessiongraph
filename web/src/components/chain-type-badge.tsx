import {
  GitCommitHorizontal,
  Compass,
  X,
  Check,
  Lightbulb,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ChainType } from "@/lib/types";

const chainConfig: Record<
  ChainType,
  { icon: React.ElementType; label: string; className: string }
> = {
  decision: {
    icon: GitCommitHorizontal,
    label: "Decision",
    className: "bg-chain-decision/15 text-chain-decision border-chain-decision/30",
  },
  exploration: {
    icon: Compass,
    label: "Exploration",
    className: "bg-chain-exploration/15 text-chain-exploration border-chain-exploration/30",
  },
  rejection: {
    icon: X,
    label: "Rejection",
    className: "bg-chain-rejection/15 text-chain-rejection border-chain-rejection/30",
  },
  solution: {
    icon: Check,
    label: "Solution",
    className: "bg-chain-solution/15 text-chain-solution border-chain-solution/30",
  },
  insight: {
    icon: Lightbulb,
    label: "Insight",
    className: "bg-chain-insight/15 text-chain-insight border-chain-insight/30",
  },
};

export function ChainTypeBadge({
  type,
  className,
}: {
  type: ChainType;
  className?: string;
}) {
  const config = chainConfig[type];
  const Icon = config.icon;

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-mono text-xs font-medium",
        config.className,
        className
      )}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}
