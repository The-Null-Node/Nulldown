import type { NullplugUiSource } from "../../../../shared/nullplug/ui";
import { nullplug } from "../registry";
import type { NullplugContext, NullplugHandler, PluginBlock } from "../types";

const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ID_ARGUMENT_PATTERN = /(?:^|[,\s])id\s*=\s*("[^"]*"|'[^']*'|[^,\s]+)/i;

const unwrapQuotedValue = (value: string): string => {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return trimmed.length >= 2 &&
    ((first === '"' && last === '"') || (first === "'" && last === "'"))
    ? trimmed.slice(1, -1).trim()
    : trimmed;
};

const parseApprovalId = (args: string | null): string | null => {
  const match = args ? ID_ARGUMENT_PATTERN.exec(args) : null;
  const id = match?.[1] ? unwrapQuotedValue(match[1]) : "";
  return APPROVAL_ID_PATTERN.test(id) ? id : null;
};

const approvalSource = (
  ctx: NullplugContext,
  callId: string,
): NullplugUiSource | undefined =>
  ctx.caller.dropId
    ? {
        rootDropId: ctx.caller.dropId,
        branchId: ctx.caller.branchId,
        callId,
      }
    : undefined;

const handleApproval: NullplugHandler = (
  ctx: NullplugContext,
  blockContent: string,
  block: PluginBlock,
) => {
  const id = parseApprovalId(block.args);
  if (!id) {
    return {
      content:
        '> Invalid approval block: add a stable id, for example `approval(id="release-42")`.',
    };
  }

  const callId = `approval:${id}`;
  const description = blockContent.trim() || "Record an approval decision.";

  return {
    content: "",
    uiPrimitives: [
      {
        kind: "form",
        id,
        title: "Approval required",
        description,
        fields: [
          {
            name: "approved",
            type: "select",
            label: "Decision",
            required: true,
            defaultValue: false,
            options: [
              { label: "Do not approve", value: false },
              { label: "Approve", value: true },
            ],
          },
          {
            name: "reason",
            type: "textarea",
            label: "Reason",
            defaultValue: "",
          },
        ],
        submitLabel: "Record decision",
        source: approvalSource(ctx, callId),
        metadata: {
          pluginId: "approval",
          responseKind: "human-approval",
        },
      },
    ],
  };
};

const approval = Object.assign(handleApproval, { pluginId: "approval" });

nullplug(approval);
