"use client";

import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  User,
  Bot,
  Terminal,
} from "lucide-react";
import type { SessionChunk } from "@/lib/types";

const roleConfig = {
  user: {
    icon: User,
    label: "User",
    bgClass: "bg-muted/50",
    borderClass: "border-primary/20",
  },
  assistant: {
    icon: Bot,
    label: "Assistant",
    bgClass: "bg-background",
    borderClass: "border-border",
  },
  system: {
    icon: Terminal,
    label: "System",
    bgClass: "bg-muted/30",
    borderClass: "border-muted-foreground/20",
  },
} as const;

export function ConversationView({ chunks }: { chunks: SessionChunk[] }) {
  const [open, setOpen] = useState(false);

  if (chunks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No conversation chunks recorded for this session.
        </p>
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="flex w-full items-center justify-between gap-2 px-4 py-3 font-mono text-sm"
        >
          <span className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Raw Conversation
            <span className="text-xs text-muted-foreground">
              ({chunks.length} message{chunks.length !== 1 ? "s" : ""})
            </span>
          </span>
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-2 space-y-0 overflow-hidden rounded-lg border border-border">
          {chunks.map((chunk, index) => {
            const config = roleConfig[chunk.role];
            const Icon = config.icon;

            return (
              <div
                key={chunk.id}
                className={`${config.bgClass} border-b ${
                  index === chunks.length - 1 ? "border-b-0" : config.borderClass
                } px-4 py-3`}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-mono text-xs font-medium text-muted-foreground">
                    {config.label}
                  </span>
                  <span className="text-xs text-muted-foreground/60">
                    #{chunk.chunk_index}
                  </span>
                </div>
                <div className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground/90">
                  {chunk.content}
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
