import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { readRequestAccountId } from "../../_lib/accountAuth";
import { resolveBranchForActor } from "../../_lib/branchState";
import { sanitizeDiffAuthToken } from "../../_lib/diffAuth";
import { resolveRemoteDropId } from "../../_lib/dropId";

interface Env {
  R2_BUCKET: R2Bucket;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

export const onRequestPost: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const id = await resolveRemoteDropId(env.R2_BUCKET, resolveId(params.id));
  if (!id) {
    return new Response("Drop ID is required.", { status: 400 });
  }

  const accountId = readRequestAccountId(request);
  const clientId = sanitizeDiffAuthToken(
    request.headers.get("x-nulldown-client-id") || new URL(request.url).searchParams.get("clientId"),
  );

  try {
    const { branch, created } = await resolveBranchForActor(
      env.R2_BUCKET,
      id,
      accountId,
      clientId,
      env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
    );

    return new Response(
      JSON.stringify({
        rootDropId: id,
        branchId: branch.branchId,
        mode: branch.mode,
        created,
        headSnapshotId: branch.headSnapshotId,
        ownerAccountId: branch.ownerAccountId,
        writerAccountId: branch.writerAccountId,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to resolve branch: ${message}`, { status: 400 });
  }
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};
