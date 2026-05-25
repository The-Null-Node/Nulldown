import {
  normalizeNullplugRuntimeReturn,
  validateNullplugRuntimeResult,
} from "./runtime";
import type { DropDiffEnvelope } from "../../../shared/drop/diff";
import type { PluginBlock } from "./types";

const block: PluginBlock = {
  id: "test",
  args: null,
  start: 10,
  end: 20,
  content: "body",
  info: "test",
};

const envelope: DropDiffEnvelope = {
  version: 1,
  events: [
    {
      eventId: "event-1",
      seq: 1,
      dropId: "drop-1",
      sourceClientId: "test-client",
      createdAt: 1,
      ops: [],
    },
  ],
};

describe("nullplug runtime normalization", () => {
  it("normalizes normalized result DTOs", () => {
    expect(
      normalizeNullplugRuntimeReturn(
        {
          content: "rendered",
          yields: [{ kind: "agent.note", value: "done" }],
        },
        block,
      ),
    ).toEqual({
      result: {
        content: "rendered",
        yields: [{ kind: "agent.note", value: "done" }],
      },
      patch: { text: "rendered" },
      diagnostics: [],
    });
  });

  it("normalizes invoke responses with diagnostics", () => {
    expect(
      normalizeNullplugRuntimeReturn(
        {
          result: { content: "remote rendered" },
          diagnostics: [{ level: "warn", message: "remote warning" }],
        },
        block,
      ),
    ).toEqual({
      result: { content: "remote rendered" },
      patch: { text: "remote rendered" },
      diagnostics: [{ level: "warn", message: "remote warning" }],
    });
  });

  it("adapts legacy renderable patches without losing custom ranges", () => {
    expect(
      normalizeNullplugRuntimeReturn({ start: 1, end: 3, text: "X" }, block),
    ).toEqual({
      result: { content: "X" },
      patch: { start: 1, end: 3, text: "X" },
      diagnostics: [],
    });
  });

  it("adapts string returns and ignores invalid objects", () => {
    expect(normalizeNullplugRuntimeReturn("rendered", block)).toEqual({
      result: { content: "rendered" },
      patch: { text: "rendered" },
      diagnostics: [],
    });
    expect(normalizeNullplugRuntimeReturn({ text: 42 }, block)).toBeNull();
    expect(normalizeNullplugRuntimeReturn(null, block)).toBeNull();
  });

  it("blocks invocation when root policy denies the plugin", () => {
    expect(
      normalizeNullplugRuntimeReturn("rendered", block, {
        policy: {
          version: 1,
          nullplugs: { test: { invoke: "deny" } },
        },
        pluginId: "test",
      }),
    ).toEqual({
      result: {},
      patch: null,
      diagnostics: [
        { level: "error", message: "Root policy denied nullplug invocation: test." },
      ],
    });
  });

  it("normalizes and downgrades privileged diff mutations through root policy", () => {
    const validated = validateNullplugRuntimeResult(
      {
        result: {
          content: "safe render",
          diffs: envelope,
          mutations: [
            { kind: "drop.diff.propose", envelope, reason: "ok" },
            { kind: "drop.diff.apply", envelope, grantId: "missing-grant" },
            { kind: "metadata.patch", patch: { title: "new" } },
          ],
          calls: [{ pluginId: "other", args: {}, caller: {} }],
          streams: [
            {
              id: "stream-1",
              kind: "agent",
              url: "https://events.nulldown.test/stream",
            },
          ],
        },
        patch: { text: "safe render" },
        diagnostics: [],
      },
      {
        policy: {
          version: 1,
          network: { allowedHosts: ["events.nulldown.test"] },
          drops: { write: "propose" },
          nullplugs: {
            test: {
              invoke: "allow",
              maxGrants: [
                { kind: "nullplug.invoke", target: "other" },
                { kind: "stream.open", target: "stream-1" },
              ],
            },
          },
        },
        pluginId: "test",
      },
    );

    expect(validated.result).toEqual({
      content: "safe render",
      mutations: [
        {
          kind: "drop.diff.propose",
          envelope,
          reason: "Normalized from legacy top-level diffs.",
        },
        { kind: "drop.diff.propose", envelope, reason: "ok" },
        {
          kind: "drop.diff.propose",
          envelope,
          reason: "Downgraded from apply mutation missing-grant.",
        },
      ],
      calls: [{ pluginId: "other", args: {}, caller: {} }],
      streams: [
        {
          id: "stream-1",
          kind: "agent",
          url: "https://events.nulldown.test/stream",
        },
      ],
    });
    expect(validated.patch).toEqual({ text: "safe render" });
    expect(validated.diagnostics).toEqual([
      { level: "info", message: "Normalized top-level diffs into a proposed mutation." },
      {
        level: "warn",
        message: "Root policy downgraded one or more apply mutations to proposals.",
      },
      { level: "warn", message: "Root policy rejected one or more nullplug mutations." },
    ]);
  });

  it("keeps apply mutations only when apply authority is available", () => {
    const validated = validateNullplugRuntimeResult(
      {
        result: {
          mutations: [{ kind: "drop.diff.apply", envelope, grantId: "grant-1" }],
        },
        patch: null,
        diagnostics: [],
      },
      {
        policy: {
          version: 1,
          drops: { write: "branch" },
        },
        pluginId: "test",
      },
    );

    expect(validated.result).toEqual({
      mutations: [{ kind: "drop.diff.apply", envelope, grantId: "grant-1" }],
    });
    expect(validated.diagnostics).toEqual([]);
  });

  it("allows UI state patch mutations only with UI state write authority", () => {
    const allowed = validateNullplugRuntimeResult(
      {
        result: {
          mutations: [
            {
              kind: "ui.state.patch",
              callId: "call-1",
              patch: [{ op: "set", path: ["expanded"], value: true }],
            },
          ],
        },
        patch: null,
        diagnostics: [],
      },
      {
        policy: {
          version: 1,
          nullplugs: {
            test: {
              maxGrants: [
                { kind: "ui.state.write", scope: "root", target: "call-1" },
              ],
            },
          },
        },
        pluginId: "test",
      },
    );

    expect(allowed.result.mutations).toHaveLength(1);

    const rejected = validateNullplugRuntimeResult(
      {
        result: allowed.result,
        patch: null,
        diagnostics: [],
      },
      { policy: { version: 1 }, pluginId: "test" },
    );

    expect(rejected.result).toEqual({});
    expect(rejected.diagnostics).toEqual([
      { level: "warn", message: "Root policy rejected one or more nullplug mutations." },
    ]);
  });

  it("rejects diff mutations when neither apply nor propose authority is available", () => {
    const validated = validateNullplugRuntimeResult(
      {
        result: {
          diffs: envelope,
          mutations: [{ kind: "drop.diff.apply", envelope, grantId: "grant-1" }],
        },
        patch: null,
        diagnostics: [],
      },
      {
        policy: {
          version: 1,
          drops: { write: "none" },
        },
        pluginId: "test",
      },
    );

    expect(validated.result).toEqual({});
    expect(validated.diagnostics).toEqual([
      { level: "info", message: "Normalized top-level diffs into a proposed mutation." },
      { level: "warn", message: "Root policy rejected one or more nullplug mutations." },
    ]);
  });

  it("rejects streams that point outside the root network policy", () => {
    const validated = validateNullplugRuntimeResult(
      {
        result: {
          streams: [
            {
              id: "stream-1",
              kind: "agent",
              url: "https://outside.example/stream",
            },
          ],
        },
        patch: null,
        diagnostics: [],
      },
      {
        policy: {
          version: 1,
          network: { allowedHosts: ["events.nulldown.test"] },
          nullplugs: {
            test: { maxGrants: [{ kind: "stream.open", target: "stream-1" }] },
          },
        },
        pluginId: "test",
      },
    );

    expect(validated.result).toEqual({});
    expect(validated.diagnostics).toEqual([
      { level: "warn", message: "Root policy rejected one or more nullplug streams." },
    ]);
  });
});
