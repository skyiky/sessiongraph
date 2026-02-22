/**
 * Terminal formatting utilities for SessionGraph CLI output.
 * Uses raw ANSI escape codes — no external dependencies.
 * Color output is automatically disabled when stdout is not a TTY (piped output).
 */

const isTTY = process.stdout.isTTY ?? false;

/** Wrap text in ANSI escape codes, no-op when not a TTY. */
function ansi(code: string, text: string): string {
  if (!isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

// ---- Colors ----

export const dim = (t: string) => ansi("2", t);
export const bold = (t: string) => ansi("1", t);
export const cyan = (t: string) => ansi("36", t);
export const green = (t: string) => ansi("32", t);
export const yellow = (t: string) => ansi("33", t);
export const red = (t: string) => ansi("31", t);
export const magenta = (t: string) => ansi("35", t);
export const white = (t: string) => ansi("37", t);
export const boldCyan = (t: string) => ansi("1;36", t);
export const boldGreen = (t: string) => ansi("1;32", t);
export const boldYellow = (t: string) => ansi("1;33", t);
export const boldRed = (t: string) => ansi("1;31", t);

// ---- Type badge colors ----

const TYPE_COLORS: Record<string, (t: string) => string> = {
  decision: boldCyan,
  exploration: boldYellow,
  rejection: boldRed,
  solution: boldGreen,
  insight: magenta,
};

/** Format a reasoning type as a colored badge, e.g. "[DECISION]" */
export function typeBadge(type: string): string {
  const colorFn = TYPE_COLORS[type] ?? bold;
  return colorFn(`[${type.toUpperCase()}]`);
}

/** Format a percentage with color (green >= 80, yellow >= 50, red < 50). */
export function colorPct(value: number, label: string): string {
  const pct = (value * 100).toFixed(1);
  if (value >= 0.8) return green(`${label}: ${pct}%`);
  if (value >= 0.5) return yellow(`${label}: ${pct}%`);
  return red(`${label}: ${pct}%`);
}

// ---- Source badge ----

const SOURCE_LABELS: Record<string, string> = {
  mcp_capture: "live",
  backfill: "backfill",
  agent_backfill: "agent",
};

/** Format a chain source as a short colored badge, e.g. "[live]" or "[backfill]" */
export function sourceBadge(source?: string): string {
  if (!source) return "";
  const label = SOURCE_LABELS[source] ?? source;
  if (source === "mcp_capture") return green(`[${label}]`);
  if (source === "backfill") return yellow(`[${label}]`);
  return cyan(`[${label}]`);
}

// ---- Status indicator ----

/** Format a chain status indicator. Only shows for non-active statuses. */
export function statusIndicator(status?: string): string {
  if (!status || status === "active") return "";
  if (status === "superseded") return dim("[superseded]");
  return dim(`[${status}]`);
}

/** Format tags as a dim comma-separated list. */
export function formatTags(tags: string[]): string {
  if (tags.length === 0) return "";
  return dim(`Tags: ${tags.join(", ")}`);
}

/** Horizontal separator line. */
export function separator(width = 60): string {
  return dim("─".repeat(width));
}

/** Format a date string to a short readable form. */
export function shortDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return dim(d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }));
  } catch {
    return dim(dateStr);
  }
}
