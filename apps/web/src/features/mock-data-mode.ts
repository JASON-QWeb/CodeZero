const enabledValues = new Set(["1", "true", "yes", "on"]);

export function isMockDataMode(): boolean {
  if (typeof window !== "undefined") {
    const search = new URLSearchParams(window.location.search);
    const queryValue = search.get("mock") ?? search.get("sampleData");
    const storedValue = window.localStorage.getItem("agent-mock-data");

    if (
      enabledValues.has((queryValue ?? "").trim().toLowerCase()) ||
      enabledValues.has((storedValue ?? "").trim().toLowerCase())
    ) {
      return true;
    }
  }

  return enabledValues.has(
    (process.env.NEXT_PUBLIC_MOCK_DATA ?? "").trim().toLowerCase(),
  );
}
