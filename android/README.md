# Shiva Android

Official Android companion app for Shiva, Yash’s personal self-hosted AI assistant.

The phone is a **trusted device node**. The Shiva server remains the brain: Gemma, memory, skills, execution modes, and confirmation policy all stay on the server. This app chats with that server over Tailscale and prepares Android device capabilities so later skills can call the phone.

```text
Android Shiva App
        │
        │ Tailscale
        ▼
Shiva Server
        │
        ▼
Gemma + Memory + Skills
```

## Requirements

- Android 8.0 (API 26) or later on the phone
- Android Studio Koala (2024.1) or newer, or JDK 17
- Android SDK Platform 35 and Build-Tools 35.0.0
- The official Tailscale Android app, connected to the same tailnet as the Shiva server
- Shiva server reachable on that tailnet (typically port 3000)

This project targets the toolchain that was available when V0.1 was built:

- Android Gradle Plugin 8.5.2
- Gradle 8.7
- Kotlin 2.0.21
- compileSdk / targetSdk 35

## Setup

1. Install Tailscale on the Android phone and sign in to your tailnet.
2. Confirm the Shiva server is on the same tailnet and listening on an address the phone can reach. If the server binds to `127.0.0.1` only, the phone cannot connect — bind it to the Tailscale IP or `0.0.0.0`.
3. Install the Shiva APK (see [Install](#install)).
4. On first launch, enter the Shiva server URL. Prefer MagicDNS, for example `http://shiva-server:3000`, or a Tailscale `100.x` address such as `http://100.x.x.x:3000`.
5. Tap **Test & continue**. The app calls `GET /health` on that origin. Tailscale being connected is not the same as Shiva being healthy.
6. Optionally enable phone capabilities, or skip and do it later in **Device**.
7. Start chatting. Messages are sent with `POST /chat`.

Do not enter `localhost` or `127.0.0.1`. Those refer to the phone itself.

## Permissions

Shiva does not request every permission at launch. Each one is explained on **Device Access** and only requested when you enable it.

| Capability | Why Shiva may need it | How Android grants it |
| --- | --- | --- |
| Internet / network state | Talk to the Shiva server | Normal install permission |
| Microphone | Future voice capture sent to *your* Shiva server | Runtime permission |
| Contacts | Resolve names such as “Call Charmi” locally. The contact database is not uploaded wholesale | Runtime permission |
| Phone calls | Initiate a call when you ask | Runtime permission (`CALL_PHONE`). Without it, Shiva can still open the dialer |
| Call information | Future call-state skills, not recording | Runtime permission |
| Notifications | React to notifications and reply when you ask. V0.1 does not upload notification contents | Notification listener system setting |
| Location | Read location when you explicitly ask. No background tracking in V0.1 | Runtime permission |
| Camera | Future capture skill | Runtime permission |
| Files / media | Future file skills through modern storage APIs | Runtime / media permissions |
| SMS | Future send/read. Android restricts this to the default SMS role | Default SMS app role |
| Accessibility | Optional UI automation where no public API exists. Never silently enabled | Accessibility system setting |
| Default assistant | So Shiva can become the selected assistant later. Hotword is not implemented | Assistant role / voice input settings |
| Battery optimization | Prepare always-connected device mode. V0.1 does not run an aggressive loop | Battery optimization exemption |

An ordinary third-party APK cannot obtain unrestricted system access. Status on Device Access is honest about that.

## Build

From this `android/` directory, using JDK 17 (Android Studio’s bundled JBR is fine):

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew test lintDebug assembleDebug
```

Debug APK:

```bash
./gradlew assembleDebug
```

The debug APK is written to:

```text
app/build/outputs/apk/debug/app-debug.apk
```

An unsigned release artifact can be produced with `./gradlew assembleRelease` when the build type has no signing config. Do not invent a production keystore password here.

## Install

With the phone connected and USB debugging enabled:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

From the repository root:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## Chat API contract

This client talks to the existing Shiva Fastify API. It does not invent a parallel contract.

**Health**

```http
GET /health
```

```json
{
  "status": "ok",
  "name": "Shiva",
  "version": "0.3.0",
  "model": "gemma4:26b-a4b-it-q4_K_M"
}
```

**Chat**

```http
POST /chat
Content-Type: application/json
```

```json
{
  "message": "Who are you?",
  "conversationId": "optional-uuid"
}
```

Successful responses are **streamed `text/plain`**. The conversation id is returned in `x-shiva-conversation-id`. Errors before the stream starts use:

```json
{
  "error": {
    "code": "CONVERSATION_NOT_FOUND",
    "message": "The requested conversation does not exist."
  }
}
```

If a device pairing token is stored, it is sent as `Authorization: Bearer …`. The current server does not require authentication; the token store is for the future pairing layer.

There is no device-command WebSocket on the server yet. Chat stays on HTTP. A `DeviceChannel` abstraction is ready for a later persistent command channel. `/voice/chat` is the server’s voice WebSocket and is not used as a phone command bus.

## Architecture notes

- UI → repository → `ShivaClient` → OkHttp
- Device identity is an installation UUID (`android_…`) in Keystore-backed storage, not IMEI
- Capabilities are queried from Android and never reported as granted until Android says so
- Device commands are routed by type to handlers (`device.phone.call`, `device.contacts.search`) instead of a giant switch
- Shiva execution modes (`SAFE` / `AUTO` / `FULL_ACCESS`) are **not** mixed into Android permission code

## Privacy

This app has no Firebase, analytics, Crashlytics, or ad SDKs. Logs redact authorization-shaped values and do not dump chat bodies.
