import { randomUUID } from "node:crypto";
import type { DropDiffEnvelope, DropDiffOp } from "../../../shared/drop/diff";
import type { CliCommand } from "../core/command";
import type { NulldownRuntime } from "../runtime/types";

const createEvent = (input: {
  dropId: string;
  clientId: string;
  ops: DropDiffOp[];
}): DropDiffEnvelope => ({
  version: 1,
  events: [
    {
      eventId: `nd-${Date.now()}-${randomUUID()}`,
      seq: 0,
      dropId: input.dropId,
      sourceClientId: input.clientId,
      createdAt: Date.now(),
      ops: input.ops,
    },
  ],
});

/** Dependencies used by modular smoke commands. */
export interface SmokeCommandDependencies {
  /** Runtime facade for smoke operations. */
  runtime: NulldownRuntime;
  /** Prints command output using the active CLI output policy. */
  print(value: unknown, human?: string): void;
  /** Returns the configured client id, if any. */
  clientId(): string | null;
}

/** Creates the modular smoke command. */
export const createSmokeCommand = <TConfig>(
  dependencies: SmokeCommandDependencies,
): CliCommand<TConfig> => ({
  name: "smoke",
  async run({ args }) {
    if (args.positionals[1] !== "diff") {
      throw new Error("Usage: nd smoke diff");
    }

    const created = await dependencies.runtime.drops.create({
      content: `nd-smoke-${Date.now()}`,
      metadata: { themeId: "system" },
    });
    const canonical = await dependencies.runtime.drops.get(created.id);
    const ops: DropDiffOp[] = [
      {
        type: "insert",
        start: canonical.text.length,
        end: canonical.text.length,
        text: "-ok",
      },
    ];
    const posted = await dependencies.runtime.diffs.postEnvelope({
      dropId: canonical.id,
      envelope: createEvent({
        dropId: canonical.id,
        clientId: dependencies.clientId() || "nd-smoke",
        ops,
      }),
    });
    dependencies.print(
      { created, posted },
      `smoke ok ${created.url}`,
    );
  },
});
