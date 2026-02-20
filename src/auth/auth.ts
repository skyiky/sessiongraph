import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { config, ensureDataDir } from "../config/config.ts";
import type { AuthState } from "../config/types.ts";

/**
 * Load saved auth state from disk.
 * Returns null if not authenticated or token expired.
 */
export async function loadAuth(): Promise<AuthState | null> {
  if (!existsSync(config.paths.auth)) return null;

  try {
    const raw = readFileSync(config.paths.auth, "utf-8");
    const state: AuthState = JSON.parse(raw);

    // Check if token is expired (with 5 min buffer)
    if (state.expiresAt < Date.now() + 5 * 60 * 1000) {
      // Try to refresh
      const refreshed = await refreshSession(state.refreshToken);
      if (refreshed) return refreshed;
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Save auth state to disk.
 */
export function saveAuth(state: AuthState): void {
  ensureDataDir();
  writeFileSync(config.paths.auth, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Clear saved auth state.
 */
export function clearAuth(): void {
  if (existsSync(config.paths.auth)) {
    unlinkSync(config.paths.auth);
  }
}

/**
 * Login with email and password.
 */
export async function login(email: string, password: string): Promise<AuthState> {
  const sb = createClient(config.supabase.url, config.supabase.anonKey);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) throw new Error(`Login failed: ${error.message}`);
  if (!data.session) throw new Error("Login failed: no session returned");

  const state: AuthState = {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    userId: data.user.id,
    email: data.user.email ?? email,
    expiresAt: (data.session.expires_at ?? 0) * 1000, // convert to ms
  };

  saveAuth(state);
  return state;
}

/**
 * Sign up with email and password.
 */
export async function signup(email: string, password: string): Promise<AuthState> {
  const sb = createClient(config.supabase.url, config.supabase.anonKey);
  const { data, error } = await sb.auth.signUp({ email, password });

  if (error) throw new Error(`Signup failed: ${error.message}`);
  if (!data.session) throw new Error("Signup successful — check your email to confirm, then run 'sessiongraph login'.");
  if (!data.user) throw new Error("Signup failed: no user returned");

  const state: AuthState = {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    userId: data.user.id,
    email: data.user.email ?? email,
    expiresAt: (data.session.expires_at ?? 0) * 1000,
  };

  saveAuth(state);
  return state;
}

/**
 * Refresh an expired session.
 */
async function refreshSession(refreshToken: string): Promise<AuthState | null> {
  try {
    const sb = createClient(config.supabase.url, config.supabase.anonKey);
    const { data, error } = await sb.auth.refreshSession({ refresh_token: refreshToken });

    if (error || !data.session || !data.user) return null;

    const state: AuthState = {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      userId: data.user.id,
      email: data.user.email ?? "",
      expiresAt: (data.session.expires_at ?? 0) * 1000,
    };

    saveAuth(state);
    return state;
  } catch {
    return null;
  }
}

/**
 * Logout — clear local auth state.
 */
export async function logout(): Promise<void> {
  const auth = await loadAuth();
  if (auth) {
    try {
      const sb = createClient(config.supabase.url, config.supabase.anonKey);
      await sb.auth.signOut();
    } catch {
      // Ignore errors on signout
    }
  }
  clearAuth();
}

/**
 * Check if currently authenticated.
 */
export async function isAuthenticated(): Promise<boolean> {
  const auth = await loadAuth();
  return auth !== null;
}
