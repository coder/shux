import "../dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { installDom } from "../dom";

import { MuxGatewaySessionExpiredDialog } from "@/browser/components/MuxGatewaySessionExpiredDialog/MuxGatewaySessionExpiredDialog";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";

describe("MuxGatewaySessionExpiredDialog", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows a Dialog when mux gateway session expires", async () => {
    const view = render(<MuxGatewaySessionExpiredDialog />);

    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED));

    await waitFor(() => {
      expect(view.getByText(MUX_GATEWAY_SESSION_EXPIRED_MESSAGE)).toBeTruthy();
      expect(view.getByText("Login to Xum Gateway")).toBeTruthy();
      expect(view.getByText("Cancel")).toBeTruthy();
    });
  });

  test("starts the OAuth login flow directly (server mode)", async () => {
    const originalFetch = globalThis.fetch;
    const originalOpen = window.open;

    let fetchUrl: string | null = null;

    globalThis.fetch = async (input, _init) => {
      fetchUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({ authorizeUrl: "https://example.com/authorize", state: "x" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    };

    const popup = {
      location: { href: "about:blank" },
      close: () => undefined,
    } as unknown as Window;

    let openedUrl: string | null = null;
    window.open = (url) => {
      openedUrl = url === undefined ? null : String(url);
      return popup;
    };

    try {
      const view = render(<MuxGatewaySessionExpiredDialog />);
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED));

      await waitFor(() => {
        expect(view.getByText("Login to Xum Gateway")).toBeTruthy();
      });

      fireEvent.click(view.getByText("Login to Xum Gateway"));

      await waitFor(() => {
        expect(openedUrl).toBe("about:blank");
        expect(fetchUrl).toBe("http://localhost/auth/mux-gateway/start");
        expect(popup.location.href).toBe("https://example.com/authorize");
        expect(view.queryByText(MUX_GATEWAY_SESSION_EXPIRED_MESSAGE)).toBeNull();
      });
    } finally {
      globalThis.fetch = originalFetch;
      window.open = originalOpen;
    }
  });

  test("shows an inline error if login cannot start (popup blocked)", async () => {
    const originalOpen = window.open;
    window.open = () => null;

    try {
      const view = render(<MuxGatewaySessionExpiredDialog />);
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED));

      await waitFor(() => {
        expect(view.getByText("Login to Xum Gateway")).toBeTruthy();
      });

      fireEvent.click(view.getByText("Login to Xum Gateway"));

      await waitFor(() => {
        expect(view.getByText("Popup blocked - please allow popups and try again.")).toBeTruthy();
        expect(view.getByText(MUX_GATEWAY_SESSION_EXPIRED_MESSAGE)).toBeTruthy();
        expect(view.getByText("Login to Xum Gateway")).toBeTruthy();
      });
    } finally {
      window.open = originalOpen;
    }
  });
});
