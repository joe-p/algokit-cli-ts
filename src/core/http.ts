import { getLogger } from "./log.js";

const logger = getLogger("httpx");

const DEFAULT_TIMEOUT_SECONDS = 5;

export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

/** Perform a HTTP GET, logging the request in the same manner as httpx. Throws on connection errors/timeouts. */
export async function httpGet(
  url: string,
  options: { headers?: Record<string, string>; timeout?: number } = {},
): Promise<HttpResponse> {
  const response = await fetch(url, {
    headers: options.headers,
    signal: AbortSignal.timeout((options.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
  });
  logger.info(`HTTP Request: GET ${url} "HTTP/1.1 ${response.status} ${response.statusText}"`);
  return {
    status: response.status,
    ok: response.ok,
    json: () => response.json(),
  };
}

