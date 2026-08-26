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

export const DEVICE_TOOLS: readonly DeviceTool[] = [
  {
    name: "device.contacts.search",
    description:
      'Search the phone\'s local contacts, matched loosely (casing/spacing-insensitive). Args: query (name to search for). Result: count, plus up to 5 candidates as name_1/phone_1/id_1, name_2/phone_2/id_2, etc, ordered by relevance.',
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
    name: "device.notification.send",
    description: "Post a notification from Shiva on the phone's notification shade. Args: title, body.",
  },
  {
    name: "device.sms.send",
    description:
      "Send an SMS text message. Args: number, message. Requires Shiva to hold the phone's default-SMS-app role; fails closed otherwise.",
  },
  {
    name: "device.location.get",
    description: "Get the phone's current location. No args. Result: latitude, longitude, accuracyMeters, ageMs.",
  },
  {
    name: "device.status.get",
    description: "Get basic device status. No args. Result: batteryPercent, charging, networkType, connected.",
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
];
