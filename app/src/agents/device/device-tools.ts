/**
 * The device.* commands the Android app actually implements (see
 * IMPLEMENTED_DEVICE_COMMAND_TYPES in ./device-protocol), described for the
 * device-agent's own planner. Deliberately no per-tool argument schema here:
 * arguments travel as a flat string map straight to the phone, and the phone
 * is the real validator — a malformed call just comes back FAILED/UNSUPPORTED
 * and the planner tries something else, the same way a person would.
 */
export interface DeviceTool {
  readonly name: string;
  readonly description: string;
}

const SELECTOR_NOTE =
  "Selector: pass one or more of text, textContains, viewId, description, descriptionContains, className, packageName, clickable, editable, scrollable, index, ignoreCase as flat arguments.";

export const DEVICE_TOOLS: readonly DeviceTool[] = [
  {
    name: "device.contacts.search",
    description: 'Search the phone\'s local contacts. Args: query (name to search for).',
  },
  {
    name: "device.phone.call",
    description:
      'Call a phone number. Args: number, direct ("true" to place the call immediately, "false" to just open the dialer pre-filled).',
  },
  {
    name: "device.notifications.list",
    description: "List recent notifications on the phone. No args.",
  },
  {
    name: "device.notifications.read",
    description: "Read one notification's full content. Args: key (from device.notifications.list).",
  },
  {
    name: "device.camera.capture",
    description: "Take a photo with the phone's camera. No args.",
  },
  {
    name: "device.app.open",
    description:
      'Open/launch an app, resolving by exact package, exact label, prefix, then substring match. Args: package or name or app (first match wins) — e.g. name="Zepto".',
  },
  {
    name: "device.app.list",
    description: "List installed apps. Args: query (optional filter), limit (default 100, max 300).",
  },
  {
    name: "device.ui.inspect",
    description: `Dump the current screen's UI tree. Args: maxNodes (default 400), verbose, includeInvisible. Use this to see what's on screen before deciding the next action.`,
  },
  {
    name: "device.ui.find",
    description: `Find UI elements matching a selector, without acting on them. ${SELECTOR_NOTE} Args also: limit (default 20).`,
  },
  {
    name: "device.ui.click",
    description: `Tap (or long-press) a UI element. ${SELECTOR_NOTE} Args also: timeoutMs, longPress.`,
  },
  {
    name: "device.ui.type",
    description: `Type text into a UI element. Args: text (required), clear (default "true" to clear the field first), timeoutMs. ${SELECTOR_NOTE}`,
  },
  {
    name: "device.ui.scroll",
    description: `Scroll a UI element. Args: direction (forward/backward/up/down/left/right), timeoutMs. ${SELECTOR_NOTE}`,
  },
  {
    name: "device.ui.wait",
    description: `Wait for a UI element to appear (or disappear with requireGone="true"). Args also: timeoutMs (default 10s). ${SELECTOR_NOTE}`,
  },
  {
    name: "device.ui.screenshot",
    description: "Capture the current screen as a JPEG. Args: maxEdgePx (default 1080).",
  },
  {
    name: "device.ui.gesture",
    description:
      "Perform a raw touch gesture. Args: kind (tap/swipe/long_press), x, y (required), toX, toY (for swipe), durationMs.",
  },
  {
    name: "device.ui.back",
    description: "Press the system Back button. No args.",
  },
  {
    name: "device.ui.global",
    description: "Trigger a system-level action. Args: action (back/home/recents/notifications/quick_settings/lock).",
  },
];
