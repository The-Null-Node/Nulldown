import {
  isDropEnvelopeV1,
  isDropPayload,
  type DropEnvelopeV1,
} from "../../../../shared/drop/types";
import { createHttpErrorFromResponse } from "./errors";
import type {
  DropCrudRecord,
  StoredDropRecord,
  VoidStorage,
  VoidStorageCreateOptions,
} from "./types";

interface ShareApiResponse {
  id?: string;
  url?: string;
  error?: string;
}

interface ListApiResponse {
  items?: Array<{ id: string; createdAt?: number; updatedAt?: number }>;
  error?: string;
}

/** HTTP-backed sealed storage for remote void provider ports. */
export class RemoteDropStorage implements VoidStorage {
  readonly scope = "remote" as const;

  async create(
    envelope: DropEnvelopeV1,
    options: VoidStorageCreateOptions = {},
  ): Promise<{ id: string; url: string }> {
    const response = await fetch("/api/store", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: options.id,
        upsert: options.upsert,
        expectedRevision: options.expectedRevision,
        envelope,
      }),
    });

    if (!response.ok) {
      throw await createHttpErrorFromResponse(
        response,
        "Failed to store drop.",
      );
    }

    const result = (await response.json()) as ShareApiResponse;
    if (!result.id || !result.url) {
      throw new Error(
        result.error || "Remote provider did not return drop URL.",
      );
    }

    return {
      id: result.id,
      url: result.url,
    };
  }

  async get(id: string): Promise<StoredDropRecord | null> {
    const response = await fetch(`/api/get/${encodeURIComponent(id)}`);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw await createHttpErrorFromResponse(
        response,
        "Failed to fetch drop.",
      );
    }

    const canonicalId = response.headers.get("X-Drop-Canonical-Id") || id;

    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as unknown;

      if (isDropEnvelopeV1(payload)) {
        const revisionHeader = response.headers.get("X-Drop-Revision");
        return {
          kind: "sealed",
          id: canonicalId,
          envelope: payload,
          createdAt: payload.createdAt,
          updatedAt: payload.createdAt,
          revision: revisionHeader,
        };
      }

      if (isDropPayload(payload)) {
        return {
          kind: "legacy",
          id: canonicalId,
          payload,
        };
      }

      throw new Error("Unsupported JSON drop payload format.");
    }

    const content = await response.text();
    return {
      kind: "legacy",
      id: canonicalId,
      payload: {
        content,
      },
    };
  }

  async list(): Promise<DropCrudRecord[]> {
    const response = await fetch("/api/list");

    if (!response.ok) {
      throw await createHttpErrorFromResponse(
        response,
        "Failed to list remote drops.",
      );
    }

    const payload = (await response.json()) as ListApiResponse;
    const items = payload.items ?? [];
    const hydrated = await Promise.all(
      items.map(async (item) => {
        const stored = await this.get(item.id);
        if (!stored || stored.kind !== "sealed") {
          return null;
        }

        return {
          id: stored.id,
          envelope: stored.envelope,
          createdAt: item.createdAt ?? stored.createdAt,
          updatedAt: item.updatedAt ?? stored.updatedAt,
        } satisfies DropCrudRecord;
      }),
    );

    return hydrated.filter((record): record is DropCrudRecord =>
      Boolean(record),
    );
  }

  async delete(id: string): Promise<void> {
    const response = await fetch(`/api/delete/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 404) {
      throw await createHttpErrorFromResponse(
        response,
        "Failed to delete remote drop.",
      );
    }
  }
}
