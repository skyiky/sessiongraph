"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function SessionDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Session detail error:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10">
          <AlertTriangle className="h-7 w-7 text-destructive" />
        </div>
        <h2 className="mt-4 font-mono text-lg font-semibold text-foreground">
          Failed to load session
        </h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {error.message || "This session could not be loaded. It may not exist or you may not have access."}
        </p>
        <div className="mt-6 flex gap-3">
          <Button asChild variant="outline" className="gap-2">
            <Link href="/sessions">
              <ArrowLeft className="h-4 w-4" />
              Back to sessions
            </Link>
          </Button>
          <Button onClick={reset} variant="outline" className="gap-2">
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
