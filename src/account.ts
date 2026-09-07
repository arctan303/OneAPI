import { DurableObject } from "cloudflare:workers";
import { AccountService } from "./account-core";
import { fetchWithLocalOutbound } from "./local-outbound";
import type { AccountStorage } from "./runtime/contracts";
import type { Env } from "./types";

export class AccountDurableObject extends DurableObject<Env> {
  private readonly service: AccountService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new AccountService(ctx.storage as unknown as AccountStorage, env, {
      outboundFetch: (request, requestGroupId) => fetchWithLocalOutbound(env.ONEAPI_LOCAL_OUTBOUND, request, requestGroupId)
    });
    ctx.blockConcurrencyWhile(() => this.service.ready);
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request);
  }

  alarm(): Promise<void> {
    return this.service.alarm();
  }
}