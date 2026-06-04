export function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: withApiAuthHeaders(init.headers),
  });
}

function withApiAuthHeaders(headers: HeadersInit | undefined): Headers {
  const next = new Headers(headers);
  const token = process.env.NEXT_PUBLIC_API_TOKEN?.trim();

  if (token && !next.has("authorization") && !next.has("x-api-key")) {
    next.set("authorization", `Bearer ${token}`);
  }

  return next;
}
