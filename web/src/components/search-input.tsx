"use client";

import { useRef } from "react";
import { Search, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  loading?: boolean;
  className?: string;
  autoFocus?: boolean;
}

export function SearchInput({
  value,
  onChange,
  onClear,
  loading = false,
  className,
  autoFocus = false,
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={cn("relative", className)}>
      <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <Search className="h-5 w-5 text-muted-foreground" />
        )}
      </div>
      <Input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search your reasoning chains..."
        autoFocus={autoFocus}
        className="h-12 rounded-xl border-border bg-card pl-12 pr-10 text-base font-sans placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/30"
      />
      {value.length > 0 && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            onClear();
            inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
