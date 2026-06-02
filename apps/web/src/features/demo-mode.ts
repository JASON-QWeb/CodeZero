const enabledValues = new Set(["1", "true", "yes", "on"]);

export function isDemoMode(): boolean {
  return enabledValues.has(
    (process.env.NEXT_PUBLIC_DEMO_MODE ?? "").trim().toLowerCase(),
  );
}
