export type AnchorKey = "cmd" | "shift";

export type KeyboardKey = string;

export type ShortcutKey = AnchorKey | KeyboardKey;

export type AnchorState = Record<AnchorKey, boolean>;

export const ANCHOR_KEY_MAP: Record<AnchorKey, string[]> = {
  cmd: ["Meta", "Control"],
  shift: ["Shift"],
};

export const createAnchorState = (): AnchorState => ({
  cmd: false,
  shift: false,
});

export const getAnchorKeysFromEventKey = (key: string): AnchorKey[] =>
  (Object.keys(ANCHOR_KEY_MAP) as AnchorKey[]).filter((anchor) =>
    ANCHOR_KEY_MAP[anchor].includes(key),
  );

type KeyEventLike = {
  type?: string;
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
};

export const updateAnchorState = (
  previous: AnchorState,
  event: KeyEventLike,
): AnchorState => {
  const next = { ...previous };

  next.cmd = Boolean(event.metaKey || event.ctrlKey);
  next.shift = Boolean(event.shiftKey);

  if (event.type === "keydown" || event.type === "keyup") {
    const anchors = getAnchorKeysFromEventKey(event.key);
    if (anchors.length) {
      const isDown = event.type === "keydown";
      anchors.forEach((anchor) => {
        next[anchor] = isDown;
      });
    }
  }

  return next;
};

export const getEngagedAnchors = (state: AnchorState): AnchorKey[] =>
  (Object.keys(state) as AnchorKey[]).filter((anchor) => state[anchor]);

export type ShortcutDefinition = {
  id: string;
  anchors: AnchorKey[];
  key?: KeyboardKey;
  onTrigger: (input: ShortcutKey, state: AnchorState) => void;
  engaged?: (state: AnchorState) => boolean;
};

export const getEngagedShortcuts = (
  shortcuts: ShortcutDefinition[],
  state: AnchorState,
): ShortcutDefinition[] =>
  shortcuts.filter((shortcut) =>
    shortcut.engaged
      ? shortcut.engaged(state)
      : shortcut.anchors.every((anchor) => state[anchor]),
  );

export const isAnchorKeyInput = (input: ShortcutKey): input is AnchorKey =>
  input === "cmd" || input === "shift";

export const onFollow = (
  shortcuts: ShortcutDefinition[],
  input: ShortcutKey,
  state: AnchorState,
): boolean => {
  const engaged = getEngagedShortcuts(shortcuts, state);

  const match = isAnchorKeyInput(input)
    ? engaged.find(
        (shortcut) => !shortcut.key && shortcut.anchors.includes(input),
      )
    : engaged.find(
        (shortcut) => shortcut.key?.toLowerCase() === input.toLowerCase(),
      );

  if (!match) return false;

  match.onTrigger(input, state);
  return true;
};
