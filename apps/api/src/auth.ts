import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

const authExemptPathPrefixes = ["/health", "/webhooks/github"];

export async function registerApiAuth(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    const token = configuredApiToken();

    if (!token || isAuthExemptPath(request.url)) {
      return;
    }

    if (requestHasValidToken(request, token)) {
      return;
    }

    return reply.code(401).send({ message: "Unauthorized" });
  });
}

function configuredApiToken(): string | undefined {
  return (
    process.env.CODEZERO_API_TOKEN?.trim() ||
    process.env.API_AUTH_TOKEN?.trim() ||
    undefined
  );
}

function isAuthExemptPath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return authExemptPathPrefixes.some((prefix) => path.startsWith(prefix));
}

function requestHasValidToken(
  request: FastifyRequest,
  expected: string,
): boolean {
  const bearer = bearerToken(request.headers.authorization);
  const apiKey = headerValue(request.headers["x-api-key"]);
  return safeEquals(bearer, expected) || safeEquals(apiKey, expected);
}

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  return match?.[1]?.trim() || undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEquals(left: string | undefined, right: string): boolean {
  if (!left) {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
