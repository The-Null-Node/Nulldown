import type { VoidBlobStore } from "../../../../../src/server/ports";

/** Result of attempting to write a drop object to durable storage. */
export type PutDropObjectResult = "stored" | "conflict" | "precondition_failed";

/** Storage options for writing a drop object. */
export interface PutDropObjectOptions {
  contentType: string;
  upsert?: boolean;
  expectedRevision?: string | null;
}

/** Minimal persistence port for writing serialized drop objects. */
export interface DropObjectRepository {
  put(
    id: string,
    payload: string,
    options: PutDropObjectOptions,
  ): Promise<PutDropObjectResult>;
}

/** Blob-store-backed implementation of the serialized drop object repository. */
export class BlobDropObjectRepository implements DropObjectRepository {
  constructor(private readonly blobs: VoidBlobStore) {}

  /** Writes a serialized drop object with create or revision-safe update semantics. */
  async put(
    id: string,
    payload: string,
    options: PutDropObjectOptions,
  ): Promise<PutDropObjectResult> {
    const upsert = options.upsert ?? false;
    const expectedRevision = options.expectedRevision ?? null;

    if (upsert) {
      if (expectedRevision) {
        const updated = await this.blobs.put(id, payload, {
          onlyIf: {
            etagMatches: expectedRevision,
          },
          httpMetadata: { contentType: options.contentType },
        });

        return updated ? "stored" : "precondition_failed";
      }

      await this.blobs.put(id, payload, {
        httpMetadata: { contentType: options.contentType },
      });
      return "stored";
    }

    const created = await this.blobs.put(id, payload, {
      onlyIf: {
        etagDoesNotMatch: "*",
      },
      httpMetadata: { contentType: options.contentType },
    });

    return created ? "stored" : "conflict";
  }
}
