import { z } from "zod";

import type { AIProvider } from "../../brain/ai-provider";
import {
  deviceErrorToFailure,
  type DeviceDispatcher,
} from "../../device/device-dispatcher";
import type { FaceRecognitionService } from "../../face/face-recognition-service";
import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";

const inputSchema = z.object({});

export type DeviceCameraCaptureInput = z.infer<typeof inputSchema>;
export interface DeviceCameraCaptureOutput {
  readonly status: "COMPLETED" | "FAILED" | "UNSUPPORTED" | "DENIED";
  /** Present when a describable image was found and the model could describe it. */
  readonly description?: string;
  /** Present instead of description when capture succeeded but describing it didn't. */
  readonly note?: string;
  readonly recognizedPeople?: readonly {
    readonly personId: string;
    readonly name: string;
    readonly isOwner: boolean;
    readonly relationship: string | null;
    readonly aliases: readonly string[];
    readonly details: Readonly<Record<string, string>>;
    readonly similarity: number;
  }[];
  readonly unknownFaceCount?: number;
}

const DESCRIBE_PROMPT =
  "Describe what is in this photo in 2-3 concise, factual sentences. Mention visible objects, people, text, or setting if relevant, but do not guess anyone's identity from appearance.";

// The exact field the device puts base64 image bytes under isn't pinned down
// yet in the wire contract, so this checks the plausible candidates in order
// rather than assuming one — and if none match, the note below reports the
// actual field names seen so the real one can be added here directly.
const IMAGE_FIELD_CANDIDATES = [
  "imageBase64",
  "image",
  "photoBase64",
  "photo",
  "jpegBase64",
  "data",
] as const;

export function createDeviceCameraCaptureSkill(
  dispatcher?: DeviceDispatcher,
  provider?: AIProvider,
  recognition?: Pick<FaceRecognitionService, "identify">,
) {
  return defineSkill<DeviceCameraCaptureInput, DeviceCameraCaptureOutput>({
    name: "device_camera_capture",
    description:
      "Takes a photo through the connected phone's camera, describes it, and locally recognizes any enrolled people. Requires the phone to be connected right now.",
    inputDescription: "{}",
    pack: "device",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      _input: DeviceCameraCaptureInput,
      context: SkillContext,
    ): Promise<SkillResult<DeviceCameraCaptureOutput>> {
      if (!dispatcher) {
        return {
          success: false,
          error: {
            code: "DEVICE_UNAVAILABLE",
            message: "The device command channel is not available.",
          },
        };
      }
      try {
        const result = await dispatcher.dispatch(
          "device.camera.capture",
          {},
          {
            timeoutMs: 90_000,
            ...(context.signal ? { signal: context.signal } : {}),
          },
        );
        if (result.status !== "COMPLETED") {
          return {
            success: false,
            error: {
              code: `DEVICE_COMMAND_${result.status}`,
              message: result.error ?? `The phone reported ${result.status}.`,
            },
          };
        }

        const imageBase64 = findImageBase64(result.result);
        if (!imageBase64) {
          const seenFields = Object.keys(result.result ?? {}).join(", ") || "none";
          return {
            success: true,
            data: {
              status: result.status,
              note: `Photo captured, but no recognizable image field was found in the device's response (fields present: ${seenFields}).`,
            },
          };
        }
        const description = provider
          ? await describePhoto(provider, imageBase64, context.signal)
          : undefined;
        const identities = recognition
          ? await recognizePhoto(
              recognition,
              context.userId,
              imageBase64,
              context.signal,
            )
          : undefined;
        return {
          success: true,
          data: {
            status: result.status,
            ...(description
              ? { description }
              : {
                  note: provider
                    ? "Photo captured, but it could not be described (the configured model may not support vision)."
                    : "Photo captured, but no model is configured to describe it.",
                }),
            ...(identities?.recognizedPeople.length
              ? { recognizedPeople: identities.recognizedPeople }
              : {}),
            ...(identities && identities.unknownFaceCount > 0
              ? { unknownFaceCount: identities.unknownFaceCount }
              : {}),
          },
        };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: deviceErrorToFailure(error) };
      }
    },
  });
}

async function recognizePhoto(
  recognition: Pick<FaceRecognitionService, "identify">,
  userId: string,
  imageBase64: string,
  signal: AbortSignal | undefined,
) {
  try {
    const result = await recognition.identify({
      userId,
      image: Buffer.from(imageBase64, "base64"),
      contentType: "image/jpeg",
      ...(signal ? { signal } : {}),
    });
    return {
      recognizedPeople: result.faces.flatMap((face) =>
        face.match
          ? [
              {
                personId: face.match.person.id,
                name: face.match.person.displayName,
                isOwner: face.match.person.isOwner,
                relationship: face.match.person.relationship,
                aliases: face.match.person.aliases,
                details: face.match.person.details,
                similarity: face.match.similarity,
              },
            ]
          : [],
      ),
      unknownFaceCount: result.faces.filter((face) => !face.match).length,
    };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

function findImageBase64(
  result: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!result) return undefined;
  for (const key of IMAGE_FIELD_CANDIDATES) {
    const value = result[key];
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

async function describePhoto(
  provider: AIProvider,
  imageBase64: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const result = await provider.chat({
      messages: [
        { role: "user", content: DESCRIBE_PROMPT, images: [imageBase64] },
      ],
      ...(signal ? { signal } : {}),
    });
    const description = result.content.trim();
    return description.length > 0 ? description : undefined;
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    // A vision-incapable model or a transient failure here shouldn't turn a
    // successful photo capture into a reported failure.
    return undefined;
  }
}
