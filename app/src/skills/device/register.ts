import type { AIProvider } from "../../brain/ai-provider";
import type { DeviceDispatcher } from "../../device/device-dispatcher";
import type { FaceRecognitionService } from "../../face/face-recognition-service";
import type { SkillRegistry } from "../registry";
import { createDeviceCallSkill } from "../device-call/skill";
import { createDeviceCameraCaptureSkill } from "../device-camera-capture/skill";
import { createDeviceContactsSearchSkill } from "../device-contacts-search/skill";
import { createDeviceNotificationsListSkill } from "../device-notifications-list/skill";
import { createDeviceNotificationsReadSkill } from "../device-notifications-read/skill";

export function registerDeviceSkills(
  registry: SkillRegistry,
  dispatcher: DeviceDispatcher,
  provider: AIProvider,
  recognition?: Pick<FaceRecognitionService, "identify">,
): void {
  registry.register(createDeviceContactsSearchSkill(dispatcher));
  registry.register(createDeviceCallSkill(dispatcher));
  registry.register(createDeviceNotificationsListSkill(dispatcher));
  registry.register(createDeviceNotificationsReadSkill(dispatcher));
  registry.register(createDeviceCameraCaptureSkill(dispatcher, provider, recognition));
}
