import type { AIProvider } from "../../brain/ai-provider.js";
import type { DeviceCommandDispatcher } from "../../device/device-command-dispatcher.js";
import type { SkillRegistry } from "../registry.js";
import { createDeviceCallSkill } from "../device-call/skill.js";
import { createDeviceCameraCaptureSkill } from "../device-camera-capture/skill.js";
import { createDeviceContactsSearchSkill } from "../device-contacts-search/skill.js";
import { createDeviceNotificationsListSkill } from "../device-notifications-list/skill.js";
import { createDeviceNotificationsReadSkill } from "../device-notifications-read/skill.js";

export function registerDeviceSkills(
  registry: SkillRegistry,
  dispatcher: DeviceCommandDispatcher,
  provider: AIProvider,
): void {
  registry.register(createDeviceContactsSearchSkill(dispatcher));
  registry.register(createDeviceCallSkill(dispatcher));
  registry.register(createDeviceNotificationsListSkill(dispatcher));
  registry.register(createDeviceNotificationsReadSkill(dispatcher));
  registry.register(createDeviceCameraCaptureSkill(dispatcher, provider));
}
