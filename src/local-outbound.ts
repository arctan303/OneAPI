const REQUEST_ID_HEADER = "X-OneAPI-Local-Request-Id";
export const LOCAL_REQUEST_GROUP_HEADER = "X-OneAPI-Local-Request-Group";
const CANCEL_ORIGIN = "https://oneapi-local-outbound.internal";
const REQUEST_GROUP_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function copyResponse(response: Response, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export async function fetchWithLocalOutbound(
  binding: Fetcher | undefined,
  request: Request,
  requestGroupId?: string
): Promise<Response> {
  if (!binding) return fetch(request);

  const requestId = crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  if (requestGroupId && REQUEST_GROUP_PATTERN.test(requestGroupId)) {
    headers.set(LOCAL_REQUEST_GROUP_HEADER, requestGroupId);
  }
  let cancelPromise: Promise<void> | undefined;
  let finished = false;
  const cancel = async () => {
    if (finished) return;
    cancelPromise ??= (async () => {
      try {
        await binding.fetch(`${CANCEL_ORIGIN}/cancel/${requestId}`, { method: "POST" });
      } catch {
        // The Node-side hard deadline remains the final cleanup boundary.
      }
    })();
    await cancelPromise;
  };
  const onAbort = () => { void cancel(); };
  const finish = () => {
    if (finished) return;
    finished = true;
    request.signal.removeEventListener("abort", onAbort);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();

  try {
    const response = await binding.fetch(new Request(request, { headers }));
    if (request.signal.aborted) await cancel();
    if (!response.body) {
      finish();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        await Promise.allSettled([reader.cancel(reason), cancel()]);
        finish();
      }
    });
    return copyResponse(response, body);
  } catch (error) {
    if (request.signal.aborted) await cancel();
    finish();
    throw error;
  }
}
