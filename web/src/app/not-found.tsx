import Link from "next/link";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="flex flex-col items-center text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
          <GitBranch className="h-7 w-7 text-muted-foreground" />
        </div>
        <h1 className="mt-6 font-mono text-4xl font-bold tracking-tight text-foreground">
          404
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page doesn&apos;t exist or you don&apos;t have access.
        </p>
        <Button asChild variant="outline" className="mt-6">
          <Link href="/">Go to Dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
