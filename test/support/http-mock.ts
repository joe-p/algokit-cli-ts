type MockResponse = { status: number; body?: unknown } | { error: Error };

/** Mock for global fetch; responses are matched by exact URL and consumed in order (the last one is reused). */
export class HttpMock {
  private responses = new Map<string, MockResponse[]>();
  requests: { url: string; headers: Record<string, string> }[] = [];

  reset(): void {
    this.responses.clear();
    this.requests = [];
  }

  addResponse(url: string, body: unknown = {}, status = 200): void {
    this.push(url, { status, body });
  }

  addException(url: string, error: Error = new Error("Connection refused")): void {
    this.push(url, { error });
  }

  private push(url: string, response: MockResponse): void {
    const list = this.responses.get(url) ?? [];
    list.push(response);
    this.responses.set(url, list);
  }

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    this.requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const list = this.responses.get(url);
    const response = list && list.length > 1 ? list.shift() : list?.[0];
    if (!response) throw new TypeError(`fetch failed: no mock response registered for ${url}`);
    if ("error" in response) throw response.error;
    const statusText = response.status === 200 ? "OK" : response.status === 404 ? "Not Found" : "Error";
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status,
      statusText,
      headers: { "content-type": "application/json" },
    });
  };
}

export const httpMock = new HttpMock();
