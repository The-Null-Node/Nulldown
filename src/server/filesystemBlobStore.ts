import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type {
  VoidBlobBody,
  VoidBlobListOptions,
  VoidBlobListResult,
  VoidBlobObject,
  VoidBlobObjectMetadata,
  VoidBlobPutOptions,
  VoidBlobStore,
} from "./ports";

/** Options for the local filesystem blob-store adapter. */
export interface FilesystemBlobStoreOptions {
  /** Directory where blob objects and metadata sidecars are stored. */
  rootDir: string;
}

interface FilesystemBlobSidecar {
  httpMetadata?: { contentType?: string };
  uploaded: string;
}

const METADATA_SUFFIX = ".void-meta.json";
const textDecoder = new TextDecoder();

const assertSafeKey = (key: string): void => {
  if (!key || key.startsWith("/") || key.includes("\0")) {
    throw new Error("void_blob_invalid_key");
  }
  const segments = key.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("void_blob_invalid_key");
  }
};

const filePathForKey = (rootDir: string, key: string): string => {
  assertSafeKey(key);
  return join(rootDir, ...key.split("/"));
};

const metadataPathForFile = (filePath: string): string => `${filePath}${METADATA_SUFFIX}`;

const toUint8Array = async (body: VoidBlobBody): Promise<Uint8Array> => {
  if (body === null) return new Uint8Array();
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array(await new Response(body).arrayBuffer());
};

const etagForBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const readSidecar = async (filePath: string): Promise<FilesystemBlobSidecar | null> => {
  try {
    const parsed = JSON.parse(await readFile(metadataPathForFile(filePath), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const sidecar = parsed as Partial<FilesystemBlobSidecar>;
    return typeof sidecar.uploaded === "string" ? sidecar as FilesystemBlobSidecar : null;
  } catch {
    return null;
  }
};

const objectMetadata = async (
  key: string,
  filePath: string,
): Promise<VoidBlobObjectMetadata | null> => {
  try {
    const [stats, bytes, sidecar] = await Promise.all([
      stat(filePath),
      readFile(filePath),
      readSidecar(filePath),
    ]);
    const etag = etagForBytes(bytes);
    return {
      key,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: sidecar?.uploaded ? new Date(sidecar.uploaded) : stats.mtime,
      size: stats.size,
      httpMetadata: sidecar?.httpMetadata,
    };
  } catch {
    return null;
  }
};

const blobObject = async (
  key: string,
  filePath: string,
): Promise<VoidBlobObject | null> => {
  try {
    const bytes = await readFile(filePath);
    const metadata = await objectMetadata(key, filePath);
    if (!metadata) return null;
    return {
      ...metadata,
      body: new Blob([bytes]).stream(),
      text: async () => textDecoder.decode(bytes),
      json: async <T = unknown>() => JSON.parse(textDecoder.decode(bytes)) as T,
    };
  } catch {
    return null;
  }
};

const writeSidecar = async (
  filePath: string,
  options: VoidBlobPutOptions | undefined,
): Promise<void> => {
  const sidecar: FilesystemBlobSidecar = {
    uploaded: new Date().toISOString(),
    ...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}),
  };
  await writeFile(metadataPathForFile(filePath), JSON.stringify(sidecar), "utf8");
};

const conditionAllowsWrite = async (
  key: string,
  filePath: string,
  options: VoidBlobPutOptions | undefined,
): Promise<boolean> => {
  const condition = options?.onlyIf;
  if (!condition) return true;
  const existing = await objectMetadata(key, filePath);
  if (condition.etagDoesNotMatch === "*" && existing) return false;
  if (condition.etagMatches && existing?.etag !== condition.etagMatches) return false;
  if (
    condition.etagDoesNotMatch &&
    condition.etagDoesNotMatch !== "*" &&
    existing?.etag === condition.etagDoesNotMatch
  ) {
    return false;
  }
  return true;
};

const walkKeys = async (rootDir: string, currentDir = rootDir): Promise<string[]> => {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkKeys(rootDir, entryPath));
      continue;
    }
    if (entry.name.endsWith(METADATA_SUFFIX)) continue;
    out.push(relative(rootDir, entryPath).split(sep).join("/"));
  }
  return out;
};

/** Creates a local filesystem-backed `VoidBlobStore` for Bun/local server adapters. */
export const createFilesystemBlobStore = ({
  rootDir,
}: FilesystemBlobStoreOptions): VoidBlobStore => ({
  get: async (key) => blobObject(key, filePathForKey(rootDir, key)),
  head: async (key) => objectMetadata(key, filePathForKey(rootDir, key)),
  put: async (key, value, options) => {
    const filePath = filePathForKey(rootDir, key);
    if (!await conditionAllowsWrite(key, filePath, options)) return null;
    const bytes = await toUint8Array(value);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    await writeSidecar(filePath, options);
    return objectMetadata(key, filePath);
  },
  delete: async (keys) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const filePath = filePathForKey(rootDir, key);
      await Promise.all([
        rm(filePath, { force: true }),
        rm(metadataPathForFile(filePath), { force: true }),
      ]);
    }
  },
  list: async (options?: VoidBlobListOptions): Promise<VoidBlobListResult> => {
    const limit = Math.max(1, Math.min(options?.limit ?? 1000, 1000));
    const offset = options?.cursor ? Math.max(0, Number.parseInt(options.cursor, 10) || 0) : 0;
    const keys = (await walkKeys(rootDir))
      .filter((key) => !options?.prefix || key.startsWith(options.prefix))
      .filter((key) => !options?.startAfter || key > options.startAfter)
      .sort();
    const page = keys.slice(offset, offset + limit);
    const objects = (
      await Promise.all(page.map((key) => objectMetadata(key, filePathForKey(rootDir, key))))
    ).filter((entry): entry is VoidBlobObjectMetadata => Boolean(entry));
    const nextOffset = offset + limit;
    return {
      objects,
      truncated: nextOffset < keys.length,
      cursor: nextOffset < keys.length ? String(nextOffset) : undefined,
    };
  },
});
