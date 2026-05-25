import type { R2Bucket } from "@cloudflare/workers-types";

export type PutDropObjectResult = "stored" | "conflict" | "precondition_failed";

export interface PutDropObjectOptions {
  contentType: string;
  upsert?: boolean;
  expectedRevision?: string | null;
}

export interface DropObjectRepository {
  put(
    id: string,
    payload: string,
    options: PutDropObjectOptions,
  ): Promise<PutDropObjectResult>;
}

export class R2DropObjectRepository implements DropObjectRepository {
  constructor(private readonly bucket: R2Bucket) {}

  async put(
    id: string,
    payload: string,
    options: PutDropObjectOptions,
  ): Promise<PutDropObjectResult> {
    const upsert = options.upsert ?? false;
    const expectedRevision = options.expectedRevision ?? null;

    if (upsert) {
      if (expectedRevision) {
        const updated = await this.bucket.put(id, payload, {
          onlyIf: {
            etagMatches: expectedRevision,
          },
          httpMetadata: { contentType: options.contentType },
        });

        return updated ? "stored" : "precondition_failed";
      }

      await this.bucket.put(id, payload, {
        httpMetadata: { contentType: options.contentType },
      });
      return "stored";
    }

    const created = await this.bucket.put(id, payload, {
      onlyIf: {
        etagDoesNotMatch: "*",
      },
      httpMetadata: { contentType: options.contentType },
    });

    return created ? "stored" : "conflict";
  }
}
