import { describe, test, expect, afterEach } from "bun:test";
import { acquireLock, LockfileError } from "./lockfile.ts";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("lockfile", () => {
  const lockPath = join(tmpdir(), `sessiongraph-test-lock-${process.pid}`);

  afterEach(() => {
    try { unlinkSync(lockPath); } catch {}
  });

  test("acquireLock creates lockfile and release removes it", () => {
    const release = acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("acquireLock throws when lock held by current process", () => {
    const release = acquireLock(lockPath);
    expect(() => acquireLock(lockPath)).toThrow(LockfileError);
    release();
  });

  test("acquireLock cleans up stale lock from dead process", () => {
    writeFileSync(lockPath, "999999999", { flag: "wx" });
    const release = acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    release();
  });

  test("release is idempotent", () => {
    const release = acquireLock(lockPath);
    release();
    release(); // no throw
    expect(existsSync(lockPath)).toBe(false);
  });
});
