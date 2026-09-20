import {
  createDropDiffRef,
  createDropDiffRenderableRef,
  hasConfirmedDropDiffAppendReceipt,
  isDropBranchRuntimeFact,
  isDropDiffAppendResponse,
  isDropDiffEnvelope,
  isDropDiffEvent,
  isDropDiffRef,
  isDropDiffRenderableRef,
  dropDiffOpToDiff,
} from "./diff";
import { decodeDiffAuthRegisterResponse } from "./diffAuth";
import { DropDiffAppendEnvelopeSchema } from "./codecs/diff-v1";
import { DiffOp } from "../nulledit/types";

const integerBoundaryCases: [string, unknown, boolean][] = [
  ["zero", 0, true],
  ["negative zero", -0, true],
  ["positive integer", 7, true],
  ["finite unsafe integer", Number.MAX_SAFE_INTEGER + 1, true],
  ["numeric string", "0", false],
  ["null", null, false],
  ["undefined", undefined, false],
  ["true", true, false],
  ["false", false, false],
  ["object", {}, false],
  ["boxed number", Object(0), false],
  ["bigint", BigInt(0), false],
  ["symbol", Symbol("sequence"), false],
  ["NaN", NaN, false],
  ["positive infinity", Infinity, false],
  ["negative infinity", -Infinity, false],
  ["negative integer", -1, false],
  ["fraction", 0.5, false],
];

const safeIntegerBoundaryCases = integerBoundaryCases.map(
  ([sample, value, expected]) => [
    sample,
    value,
    sample === "finite unsafe integer" ? false : expected,
  ] as [string, unknown, boolean],
);

describe("DropDiffRef", () => {
  it("formats and validates renderable diff refs", () => {
    const ref = createDropDiffRenderableRef("evt-1");

    expect(ref).toBe("<diff:evt-1>");
    expect(isDropDiffRenderableRef(ref)).toBe(true);
    expect(isDropDiffRenderableRef("diff:evt-1")).toBe(false);
  });

  it("creates stable branch diff refs", () => {
    const ref = createDropDiffRef({
      rootDropId: "root-1",
      branchId: "owner",
      seq: 7,
      eventId: "evt-7",
      snapshotId: 3,
    });

    expect(ref).toEqual({
      rootDropId: "root-1",
      branchId: "owner",
      seq: 7,
      eventId: "evt-7",
      ref: "<diff:evt-7>",
      snapshotId: 3,
    });
    expect(isDropDiffRef(ref)).toBe(true);
    expect(isDropDiffRef({ ...ref, ref: "<diff:other>" })).toBe(false);
  });
});

describe("DropBranchRuntimeFact", () => {
  const fact = {
    version: 1,
    rootDropId: "root-1",
    branchId: "branch-1",
    seq: 0,
    factId: "ui.state.patch:patch-1",
    createdAt: 1,
    fact: {
      version: 1,
      kind: "ui.state.patch",
      id: "patch-1",
      callId: "call-1",
      createdAt: 1,
      source: {
        rootDropId: "root-1",
        branchId: "branch-1",
        callId: "call-1",
      },
      patch: [{ op: "set", path: ["approved"], value: true }],
    },
  };

  it("requires the payload source to match its branch timeline", () => {
    expect(isDropBranchRuntimeFact(fact)).toBe(true);
    expect(
      isDropBranchRuntimeFact({
        ...fact,
        branchId: "other-branch",
      }),
    ).toBe(false);
  });

  it("requires version 1 and matching root identity", () => {
    expect(isDropBranchRuntimeFact({ ...fact, version: 2 })).toBe(false);
    expect(isDropBranchRuntimeFact({ ...fact, rootDropId: "other-root" })).toBe(
      false,
    );
  });

  it("preserves the non-negative integer boundary for seq", () => {
    for (const [sample, seq, expected] of integerBoundaryCases) {
      expect({
        sample,
        valid: isDropBranchRuntimeFact({ ...fact, seq }),
      }).toEqual({ sample, valid: expected });
    }
  });
});

describe("DiffAuthRegisterResponse", () => {
  const response = {
    dropId: "drop-1",
    branchId: "branch-1",
    clientId: "client-1",
    kid: "kid-1",
    wrappedSecret: "c2VjcmV0",
    expiresAt: 1_700_000_000_000,
  };

  it("decodes the exact registration response shape", () => {
    expect(decodeDiffAuthRegisterResponse(response)).toEqual(response);
  });

  it.each([
    ["missing wrapped secret", { ...response, wrappedSecret: undefined }],
    ["malformed wrapped secret", { ...response, wrappedSecret: "not base64!" }],
    ["unsafe expiry", { ...response, expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["unexpected field", { ...response, extra: true }],
  ])("rejects a %s response", (_label, value) => {
    expect(decodeDiffAuthRegisterResponse(value)).toBeNull();
  });
});

describe("DropDiffAppendResponse", () => {
  const acknowledgement = {
    eventId: "event-1",
    seq: 0,
    snapshotId: 1,
    status: "accepted" as const,
  };

  const response = {
    accepted: 1,
    deduplicated: 0,
    branchId: "branch-1",
    snapshotId: 1,
    totalStored: 1,
    acknowledgements: [acknowledgement],
  };

  it.each(["accepted", "deduplicated", "snapshotId", "totalStored"])(
    "preserves the non-negative integer boundary for %s",
    (field) => {
      for (const [sample, value, expected] of safeIntegerBoundaryCases) {
        expect({
          sample,
          valid: isDropDiffAppendResponse({ ...response, [field]: value }),
        }).toEqual({ sample, valid: expected });
      }
    },
  );

  it.each(["seq", "snapshotId"])(
    "preserves the non-negative integer boundary for acknowledgement %s",
    (field) => {
      for (const [sample, value, expected] of safeIntegerBoundaryCases) {
        expect({
          sample,
          valid: isDropDiffAppendResponse({
            ...response,
            acknowledgements: [{ ...acknowledgement, [field]: value }],
          }),
        }).toEqual({ sample, valid: expected });
      }
    },
  );

  it("requires a snapshot-bearing acknowledgement receipt", () => {
    expect(
      isDropDiffAppendResponse({
        accepted: 1,
        deduplicated: 0,
        branchId: "branch-1",
        snapshotId: 1,
        totalStored: 1,
        acknowledgements: [acknowledgement],
      }),
    ).toBe(true);
    expect(
      isDropDiffAppendResponse({
        accepted: 1,
        deduplicated: 0,
        branchId: "branch-1",
        snapshotId: 1,
        totalStored: 1,
        acknowledgements: [{ ...acknowledgement, snapshotId: undefined }],
      }),
    ).toBe(false);
  });

  it("requires matching branch, totals, and acknowledgement status", () => {
    const response = {
      accepted: 1,
      deduplicated: 0,
      branchId: "branch-1",
      snapshotId: 1,
      totalStored: 1,
      acknowledgements: [acknowledgement],
    };

    expect(
      hasConfirmedDropDiffAppendReceipt(response, {
        branchId: "branch-1",
        eventIds: ["event-1"],
      }),
    ).toBe(true);
    expect(
      hasConfirmedDropDiffAppendReceipt(
        { ...response, branchId: "other-branch" },
        { branchId: "branch-1", eventIds: ["event-1"] },
      ),
    ).toBe(false);
    expect(
      hasConfirmedDropDiffAppendReceipt(
        { ...response, accepted: 0, deduplicated: 1 },
        { branchId: "branch-1", eventIds: ["event-1"] },
      ),
    ).toBe(false);
  });

  it("rejects event ids with surrounding whitespace", () => {
    expect(
      isDropDiffEvent({
        eventId: " event-1 ",
        seq: 0,
        dropId: "drop-1",
        sourceClientId: "client-1",
        createdAt: 1,
        ops: [{ type: "insert", start: 0, end: 0, text: "hello" }],
      }),
    ).toBe(false);
  });
});

describe("legacy diff envelopes", () => {
  it("keeps legacy unsafe integers readable while rejecting them for new appends", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const legacyEnvelope = {
      version: 1,
      events: [
        {
          eventId: "legacy-unsafe-event",
          seq: unsafe,
          dropId: "root-fixture",
          sourceClientId: "legacy-client",
          createdAt: unsafe,
          snapshotId: unsafe,
          metadata: { batchIndex: unsafe, followsSeq: unsafe },
          ops: [
            {
              type: "insert" as const,
              start: unsafe,
              end: unsafe,
              text: "legacy",
            },
          ],
        },
      ],
    };

    expect(isDropDiffEnvelope(legacyEnvelope)).toBe(true);
    expect(DropDiffAppendEnvelopeSchema.safeParse(legacyEnvelope).success).toBe(
      false,
    );
  });

  it("replays a legacy text-only v1 diff envelope without changing event ownership", () => {
    const raw =
      '{"version":1,"events":[{"eventId":"legacy-event-4","seq":4,"dropId":"root-fixture","sourceClientId":"legacy-client","createdAt":1700000000000,"snapshotId":3,"ops":[{"type":"insert","start":5,"end":5,"text":" legacy"}]}]}';
    const parsed = JSON.parse(raw) as unknown;

    expect(isDropDiffEnvelope(parsed)).toBe(true);
    if (!isDropDiffEnvelope(parsed))
      throw new Error("fixture must be a diff envelope");

    const restored = dropDiffOpToDiff(parsed.events[0].ops[0]);
    expect(restored).not.toBeNull();
    expect(restored).toMatchObject({
      op: DiffOp.INSERT,
      range: { start: 5, end: 5 },
    });
    expect(new TextDecoder().decode(restored?.data)).toBe(" legacy");
    expect(parsed.events[0]).toMatchObject({
      eventId: "legacy-event-4",
      seq: 4,
      dropId: "root-fixture",
      sourceClientId: "legacy-client",
      snapshotId: 3,
    });
    expect(JSON.stringify(parsed)).toBe(raw);
  });

  it("preserves authoritative native diff bytes when both representations exist", () => {
    const raw =
      '{"version":1,"events":[{"eventId":"native-event-9","seq":9,"dropId":"root-fixture","sourceClientId":"native-client","createdAt":1700000001000,"ops":[{"type":"insert","start":8,"end":8,"text":"ignored legacy text","native":{"op":1,"data":"AP8Q","range":{"start":2,"end":5}}}]}]}';
    const parsed = JSON.parse(raw) as unknown;

    expect(isDropDiffEnvelope(parsed)).toBe(true);
    if (!isDropDiffEnvelope(parsed))
      throw new Error("fixture must be a diff envelope");

    const restored = dropDiffOpToDiff(parsed.events[0].ops[0]);
    expect(restored).not.toBeNull();
    expect(restored).toMatchObject({
      op: DiffOp.DELETE,
      range: { start: 2, end: 5 },
    });
    expect(
      Array.from(new Uint8Array(restored?.data ?? new ArrayBuffer(0))),
    ).toEqual([0, 255, 16]);
    expect(parsed.events[0]).toMatchObject({
      eventId: "native-event-9",
      seq: 9,
      dropId: "root-fixture",
      sourceClientId: "native-client",
    });
    expect(JSON.stringify(parsed)).toBe(raw);
  });
});
