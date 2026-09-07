import type { GatewayRequestContext } from '../src/runtime/contracts';

export interface HttpServerOptions {
  runtime: {
    fetch(request: Request, context?: GatewayRequestContext): Promise<Response>;
  };
  host?: string;
  port?: number;
  publicOrigin?: string;
  lanOrigins?: string | string[];
}

export function startHttpServer(options: HttpServerOptions): Promise<{
  url: URL;
  close(): Promise<void>;
}>;
