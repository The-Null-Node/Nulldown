import type {
  IncomingRequestCfProperties,
  PagesFunction,
} from "@cloudflare/workers-types";
import { onRequest as telemetry } from "./_lib/core/observability/middleware";
import type { TelemetryBinding } from "./_lib/core/observability/transport";
import {
  fetchProductionEnrollment,
  type ProductionIngressBindings,
} from "../../packages/nulldown-state-plane/src/production-ingress";

/** Applies deployment-owned branch enrollment inside the existing request telemetry lifetime. */
export const onRequest: PagesFunction<
  ProductionIngressBindings & { TELEMETRY?: TelemetryBinding }
> = async (context) =>
  telemetry({
    ...context,
    async next(input, init) {
      const request = input
        ? new Request<unknown, IncomingRequestCfProperties>(input, {
            ...init,
            cf: context.request.cf,
          })
        : context.request;
      const selected = await fetchProductionEnrollment(
        request,
        context.env,
        context,
      );
      return selected ?? context.next(request);
    },
  });
