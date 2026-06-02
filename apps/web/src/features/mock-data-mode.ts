const enabledValues = new Set(["1", "true", "yes", "on"]);

export function isMockDataMode(): boolean {
  return enabledValues.has(
    (process.env.NEXT_PUBLIC_MOCK_DATA ?? "").trim().toLowerCase(),
  );
}
