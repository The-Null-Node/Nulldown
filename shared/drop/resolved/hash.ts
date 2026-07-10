import { NULLDOWN_SOURCE_HASH_PREFIX } from "./constants";
import type { BranchSnapshotSource, NulldownSourceHash } from "./types";

const sourceHashPattern = /^sha256:[A-Za-z0-9_-]{43}$/;

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const isNulldownSourceHash = (
  value: unknown,
): value is NulldownSourceHash =>
  typeof value === "string" && sourceHashPattern.test(value);

export const buildMarkdownSourceHashKey = (dropId: string): string =>
  `drop:${dropId}:content`;

export const buildBranchSnapshotSourceHashKey = ({
  rootDropId,
  branchId,
  snapshotId,
}: Omit<BranchSnapshotSource, "content">): string =>
  `branch:${rootDropId}:${branchId}:snapshot:${snapshotId}:content`;

export const hashNulldownSourceContent = async (
  content: string,
): Promise<NulldownSourceHash> => {
  const bytes = new TextEncoder().encode(`nulldown.source-content.v1\n${content}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `${NULLDOWN_SOURCE_HASH_PREFIX}${toBase64Url(new Uint8Array(digest))}`;
};

export const hashMarkdownSource = (content: string): Promise<NulldownSourceHash> =>
  hashNulldownSourceContent(content);

export const hashBranchSnapshotSource = ({
  content,
}: BranchSnapshotSource): Promise<NulldownSourceHash> =>
  hashNulldownSourceContent(content);
