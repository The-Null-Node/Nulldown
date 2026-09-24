import { DIFF_TEXT_MAX_LENGTH } from "../../../shared/drop/diffSchemas";

const FRAME_PREFIX = "⟦𝙽𝙳𝙱𝟷⟧";

export interface MemoryAgentBenchChunkFrame {
  nodeText: string;
  sourceText: string;
}

// JSON keeps each chunk on one line; escaping '[' prevents extra link-reference nodes.
const encodePayload = (chunk: string): string =>
  JSON.stringify(chunk).replaceAll("[", "\\u005b");

export const frameMemoryAgentBenchChunk = (
  chunk: string,
): MemoryAgentBenchChunkFrame => {
  if (typeof chunk !== "string") {
    throw new TypeError("MemoryAgentBench chunks must be strings.");
  }

  const nodeText = `${FRAME_PREFIX}${encodePayload(chunk)}`;
  const sourceText = `${nodeText}\n\n`;
  if (sourceText.length >= DIFF_TEXT_MAX_LENGTH) {
    throw new RangeError(
      `Encoded MemoryAgentBench chunk must be shorter than ${DIFF_TEXT_MAX_LENGTH} UTF-16 code units.`,
    );
  }
  return { nodeText, sourceText };
};

export const decodeMemoryAgentBenchChunk = (nodeText: string): string => {
  if (typeof nodeText !== "string" || !nodeText.startsWith(FRAME_PREFIX)) {
    throw new Error("Invalid MemoryAgentBench chunk frame prefix.");
  }
  if (nodeText.includes("\n") || nodeText.includes("\r")) {
    throw new Error("Invalid MemoryAgentBench chunk frame line structure.");
  }

  const payload = nodeText.slice(FRAME_PREFIX.length);
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new Error("Invalid MemoryAgentBench chunk frame payload.");
  }
  if (typeof decoded !== "string") {
    throw new Error("Invalid MemoryAgentBench chunk frame value.");
  }
  if (frameMemoryAgentBenchChunk(decoded).nodeText !== nodeText) {
    throw new Error("Non-canonical MemoryAgentBench chunk frame.");
  }
  return decoded;
};
