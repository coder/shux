---
title: Mobile companion
description: Develop the React Native Xum companion and connect it to your server.
---

The experimental mobile companion lives in `packages/mobile`. It uses native React Native views, with React Native Web for browser development—not an embedded copy of the desktop website.

It connects to your existing Xum server for projects, workspace creation, conversations, agent/model selection, and read-only changes. On phones, a searchable workspace list opens conversations in a native navigation stack; wider screens keep the workspace sidebar visible. Phone workspace search and creation stay in a bottom dock, while wide layouts keep their controls above the list. Conversation headers show project and server context with grouped navigation actions. Drafts and unsent model choices survive returning to the list. The composer stays compact when empty and unfocused, expands for writing, and stays at the bottom with mode/model controls directly above it. Creation uses a sheet with a pinned action. The composer's separate model and mode controls open focused pickers; selections apply immediately, and changing mode preserves the chosen model and effort. Search models directly in the model picker by name, provider, or alias. The grouped list follows model visibility in Settings and includes models available through configured gateway routes; the current selection remains visible even if subsequently hidden. Use Effort to adjust thinking. Custom model IDs require confirmation. Tool activity stays compact in the conversation; tap a tool to inspect its input, output, and status. Provider configuration, terminal/desktop access, and advanced administration remain in the main Xum app.

## Connect to a server

Enable [server access](/config/server-access), or start `xum server`. Use a trusted HTTPS endpoint accessible from the device and enter the server's bearer token separately. Include any reverse-proxy path prefix in the endpoint. A Coder login page or another upstream authentication layer may require additional network access; the Xum token does not authenticate to that outer layer.

During development, run the mobile client and server from the same branch/revision. Their shared API contract evolves together; for example, the multi-repository changes view requires the server's bulk project-diff endpoint.

The token grants access to the server, including its code-execution capabilities. Treat it like a password. Native builds save connection details in device secure storage. The web preview keeps them in memory only; refreshing requires entering them again. Disconnect clears the saved native connection.

Before opening a WebSocket, the companion exchanges the token in an HTTP Authorization header for a short-lived, single-use upgrade ticket. The long-lived token is not included in the WebSocket URL or subprotocols. Older servers without ticket support must be updated; there is no credential-URL fallback.

Public endpoints require HTTPS. Literal private LAN and loopback HTTP addresses are accepted for development, with a plaintext-token warning. Mobile platform transport policies may still restrict cleartext networking; prefer HTTPS on devices. A phone's `localhost` refers to the phone, not your development computer.

## Develop with React Native Web

Install the repository's Bun dependencies and use Node.js 22.19 or later for Expo and the preview proxy:

```bash
bun install
make mobile-install

# Point this at a running Xum instance. Do not put the token in the URL.
XUM_MOBILE_ENDPOINT=http://127.0.0.1:3000 make mobile-web
```

Open `http://127.0.0.1:8082` in a current Chromium browser, then enter that configured **server endpoint** and its token. Metro runs on port 8081; use the proxy on 8082, not Metro's direct URL, for API access. The web preview uses CSS content sizing for the composer; native builds use React Native's text measurement.

With the Message composer focused, Enter sends in desktop-sized windows with a fine pointer; Shift+Enter inserts a newline. Narrow windows and coarse-pointer devices keep Enter for newlines. Ctrl+Enter (or Cmd+Enter on macOS) sends while idle on either layout. Escape uses the active conversation's Stop action. Shortcuts respect disabled actions and composition, do not run from other inputs or modal dialogs, and do not queue messages or stop a turn when Enter is pressed during streaming.

The preview forwards to exactly one endpoint configured at startup. It checks the request Host and Origin before forwarding, strips preview cookies/forwarded identity, and preserves the upstream path prefix. It does not relax the production server's origin protections. Native builds connect directly and do not need this proxy.

Optional development settings:

- `MOBILE_METRO_PORT`: Metro port (Make variable).
- `XUM_MOBILE_PORT`: preview port, default 8082.
- `XUM_MOBILE_ORIGIN`: exact public preview origin when forwarding this loopback-bound server; the forwarding proxy must preserve that Host.
- `XUM_MOBILE_ENDPOINT`: the fixed Xum target; restart the preview to change it.

Serve a production web export:

```bash
make mobile-export
XUM_MOBILE_ENDPOINT=http://127.0.0.1:3000 make mobile-preview
```

The preview is development tooling, not a general-purpose public proxy. It intentionally runs under Node: Bun's Node HTTP compatibility can stall forwarded WebSocket frames.

## Native development

```bash
make mobile-native
```

Use Expo's device/simulator workflow with the installed SDK-compatible client or development build. The native app uses `expo-secure-store` and safe-area/keyboard-aware layouts. Native networking, keyboard behavior, secure storage, and background/resume behavior still need device testing; a successful JavaScript export does not establish that they work on iOS.

```bash
# Compiles the iOS JavaScript/Hermes bundle; does not launch or build a simulator app.
make mobile-export-ios
```

Send/Stop keyboard shortcuts currently apply only to React Native Web. Native software-keyboard Enter behavior is unchanged; native hardware-keyboard Send/Stop bindings are not implemented. The installed native TextInput APIs do not expose the modifier/source information needed for that behavior without additional native integration.

The mobile dependency graph and lockfile are isolated from desktop React. Update SDK-compatible versions together and run `bun x expo install --check` from `packages/mobile` after dependency changes.

## Validation and dogfooding

```bash
make mobile-check
make mobile-export
make mobile-export-ios
```

`mobile-check` runs typechecking against the shared API schemas, lint/format checks, and endpoint, transport, transcript, lifecycle, and preview-proxy tests. For the opt-in real-server test, use a **disposable** Xum root with `XUM_MOCK_AI=1`, then run:

```bash
cd packages/mobile
XUM_MOBILE_TEST_ENDPOINT=http://127.0.0.1:3000 \
XUM_MOBILE_TEST_TOKEN=your-disposable-server-token \
bun test ./scripts/server.integration.test.ts
```

That test creates and removes a scratch workspace. It exercises real authentication, persistence, streaming and reconnect/replay; only the model response is deterministic.

With the production preview running against that same disposable server, run the full-app browser regressions from the repository root:

```bash
# One-time browser installation
(cd packages/mobile && bun x playwright install chromium)
XUM_MOBILE_TEST_ENDPOINT=http://127.0.0.1:3000 \
XUM_MOBILE_TEST_TOKEN=your-disposable-server-token \
make mobile-test-web
```

These tests pin 375px, 390px, and 1200px viewports, create and remove scratch chats, and check draft/model retention, keyboard focus, and reachable sheet actions. Set `XUM_MOBILE_TEST_WEB_URL` if the preview is not at `http://127.0.0.1:8082`.

For a browser walkthrough, use the production preview and a phone viewport around 375–390 pixels, then repeat at tablet/desktop width:

1. Check invalid URL, wrong token, and successful connection.
2. Open the workspace navigator; create a scratch chat and a project workspace.
3. Send a message, observe streamed text/tools/reasoning, and interrupt a running turn.
4. Change agent/model settings, switch workspaces, and verify conversations do not mix.
5. Open Changes and Settings; disconnect and confirm credentials are not retained in browser storage.
6. Drop the connection, retry, and verify authoritative history reloads before sending is enabled.
7. Capture screenshots and a short recording of the walkthrough, including narrow layouts and any failure/recovery steps.

## Can Xum run inside the native JS engine?

**Not the existing backend unchanged.** Hermes executes JavaScript, but it does not provide Xum's Node filesystem/process APIs, shell/git toolchain, PTY bindings, or database/native addons. The companion runs its UI and client logic locally; agent execution stays on the server.

A native Node sidecar would be a separate runtime and substantial platform port. It would not make the desktop shell tools available inside an iOS sandbox. This app does not advertise an embedded backend mode.

Research references:

- [React Native core/native views](https://reactnative.dev/docs/intro-react-native-components)
- [Hermes](https://reactnative.dev/docs/hermes)
- [Expo web support](https://docs.expo.dev/workflow/web/)
- [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)
- [Node.js Mobile's separate native runtime](https://nodejs-mobile.github.io/docs/guide/guide-react-native/getting-started/)
