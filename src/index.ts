import { AccountDurableObject } from "./account";
import { configuredOrigin, handleGatewayRequest } from "./gateway";
import type { Env } from "./types";

export { AccountDurableObject, configuredOrigin };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    let stub: DurableObjectStub | undefined;
    const account = (): DurableObjectStub => {
      if (!stub) {
        const id = env.ACCOUNT.idFromName("primary");
        stub = env.ACCOUNT.get(id);
      }
      return stub;
    };
    return handleGatewayRequest(request, env, {
      accountFetch: (forwarded) => account().fetch(forwarded),
      staticFetch: (forwarded) => env.ASSETS.fetch(forwarded),
      cancelLease: async (leaseId) => {
        await account().fetch(`https://oneapi.internal/__internal/cancel?lease_id=${encodeURIComponent(leaseId)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.TOKEN_ENCRYPTION_KEY}` }
        });
      },
      allowInternalControl: true,
      allowLoopbackWithoutPeer: true,
      log: (entry) => console.log(JSON.stringify(entry))
    });
  }
};