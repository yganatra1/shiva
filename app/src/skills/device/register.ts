import type { DeviceCommandDispatcher } from "../../device/device-command-dispatcher.js";
import type { SkillRegistry } from "../registry.js";
import { createDeviceCallSkill } from "../device-call/skill.js";
import { createDeviceContactsSearchSkill } from "../device-contacts-search/skill.js";

export function registerDeviceSkills(
  registry: SkillRegistry,
  dispatcher: DeviceCommandDispatcher,
): void {
  registry.register(createDeviceContactsSearchSkill(dispatcher));
  registry.register(createDeviceCallSkill(dispatcher));
}
