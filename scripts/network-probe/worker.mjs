import { DurableObject } from 'cloudflare:workers';
import { handleProbeDoRequest, handleWorkerRequest, safeHandle } from './core.mjs';

export class ProbeDO extends DurableObject {
  async fetch(request) {
    return safeHandle(() => handleProbeDoRequest(request, this.env));
  }
}

export default {
  async fetch(request, env) {
    return safeHandle(() => handleWorkerRequest(request, env));
  },
};
