// VS Code webview script for the mux secondary sidebar chat view.
//
// This is intentionally "no framework" to keep bootstrapping simple and debuggable.
//
// Debugging philosophy:
// - Always write to both the in-webview Debug panel and the Webview DevTools console.
// - Send a small number of key debug events back to the extension host via `debugLog`.
// - Include a stable traceId on every message to correlate logs.

(function () {
  "use strict";

  const traceId = (document.body && document.body.dataset && document.body.dataset.muxTraceId) || "unknown";
  const startedAtMs = Date.now();

  const statusEl = document.getElementById("status");
  const debugLogEl = document.getElementById("debugLog");
  const copyDebugBtn = document.getElementById("copyDebugBtn");

  const workspaceSelectEl = document.getElementById("workspaceSelect");
  const refreshBtn = document.getElementById("refreshBtn");
  const openBtn = document.getElementById("openBtn");
  const configureBtn = document.getElementById("configureBtn");

  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");

  const debugLines = [];
  const DEBUG_MAX_LINES = 500;

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function appendDebug(message, data) {
    const ts = new Date().toISOString();
    const suffix = data === undefined ? "" : " " + safeStringify(data);
    const line = `${ts} [${traceId}] ${message}${suffix}`;

    debugLines.push(line);
    if (debugLines.length > DEBUG_MAX_LINES) {
      debugLines.splice(0, debugLines.length - DEBUG_MAX_LINES);
    }

    if (debugLogEl) {
      debugLogEl.textContent = debugLines.join("\n");
      debugLogEl.scrollTop = debugLogEl.scrollHeight;
    }

    // Always mirror to DevTools console.
    try {
      // eslint-disable-next-line no-console
      console.log("[mux-webview]", line);
    } catch {
      // ignore
    }
  }

  function setStatus(text) {
    if (statusEl) {
      statusEl.textContent = text;
    }
  }

  setStatus(`mux webview: js loaded (trace ${traceId})`);
  appendDebug("boot", {
    traceId,
    userAgent: navigator.userAgent,
    startedAtMs,
  });

  let vscode;
  try {
    vscode = acquireVsCodeApi();
    appendDebug("acquireVsCodeApi ok");
  } catch (error) {
    appendDebug("acquireVsCodeApi failed", String(error));
    setStatus(`mux webview: acquireVsCodeApi failed: ${String(error)}`);
    return;
  }

  let nextSeq = 1;

  function postToExtension(payload) {
    const meta = {
      traceId,
      seq: nextSeq++,
      sentAtMs: Date.now(),
      sinceStartMs: Date.now() - startedAtMs,
    };

    const message = Object.assign({ __muxMeta: meta }, payload);

    try {
      vscode.postMessage(message);
      appendDebug(`tx ${payload && payload.type ? payload.type : "(unknown)"}`, meta);
    } catch (error) {
      appendDebug("vscode.postMessage threw", String(error));
    }
  }

  function appendNotice(level, message) {
    if (!messagesEl) {
      return;
    }

    const el = document.createElement("div");
    el.className = `msg notice ${level || "info"}`;

    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = level === "error" ? "error" : "info";

    const bodyEl = document.createElement("div");
    bodyEl.textContent = message;

    el.appendChild(metaEl);
    el.appendChild(bodyEl);

    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const state = {
    workspaces: [],
    selectedWorkspaceId: null,
    connectionStatus: { mode: "file" },
  };

  function updateControls() {
    const hasSelection = Boolean(state.selectedWorkspaceId);

    if (openBtn) {
      openBtn.disabled = !hasSelection;
    }

    const canChat = Boolean(state.connectionStatus && state.connectionStatus.mode === "api" && hasSelection);

    if (sendBtn) {
      sendBtn.disabled = !canChat;
    }

    if (inputEl) {
      inputEl.disabled = !canChat;
      inputEl.placeholder = canChat
        ? "Message mux…"
        : hasSelection
          ? "Chat requires mux server connection."
          : "Select a mux workspace to chat.";
    }
  }

  function renderWorkspaces() {
    if (!workspaceSelectEl) {
      return;
    }

    while (workspaceSelectEl.firstChild) {
      workspaceSelectEl.removeChild(workspaceSelectEl.firstChild);
    }

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = state.workspaces.length > 0 ? "Select workspace…" : "No workspaces found";
    workspaceSelectEl.appendChild(placeholder);

    for (const ws of state.workspaces) {
      const opt = document.createElement("option");
      opt.value = ws.id;
      opt.textContent = ws.label;
      workspaceSelectEl.appendChild(opt);
    }

    workspaceSelectEl.value = state.selectedWorkspaceId || "";
    updateControls();
  }

  function setConnectionStatus(status) {
    state.connectionStatus = status;

    const parts = [];
    if (status.mode === "api") {
      parts.push("Connected to mux server");
      if (status.baseUrl) {
        parts.push(status.baseUrl);
      }
    } else {
      parts.push("Using local file access");
      if (status.baseUrl) {
        parts.push("Server: " + status.baseUrl);
      }
    }

    if (status.error) {
      parts.push(status.error);
    }

    setStatus(parts.join("\n"));
    updateControls();
  }

  function resetChat() {
    if (!messagesEl) {
      return;
    }

    while (messagesEl.firstChild) {
      messagesEl.removeChild(messagesEl.firstChild);
    }
  }

  function renderChatEvent(event) {
    if (!messagesEl) {
      return;
    }

    const el = document.createElement("div");
    el.className = "msg assistant";

    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = "event";

    const details = document.createElement("details");
    details.className = "part";

    const summary = document.createElement("summary");
    summary.textContent = "chatEvent";

    const pre = document.createElement("pre");
    pre.textContent = safeStringify(event);

    details.appendChild(summary);
    details.appendChild(pre);

    el.appendChild(metaEl);
    el.appendChild(details);

    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // --- UI event handlers

  if (workspaceSelectEl) {
    workspaceSelectEl.addEventListener("change", () => {
      const id = workspaceSelectEl.value || null;
      state.selectedWorkspaceId = id;
      updateControls();
      postToExtension({ type: "selectWorkspace", workspaceId: id });
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      postToExtension({ type: "refreshWorkspaces" });
    });
  }

  if (openBtn) {
    openBtn.addEventListener("click", () => {
      if (!state.selectedWorkspaceId) {
        return;
      }
      postToExtension({ type: "openWorkspace", workspaceId: state.selectedWorkspaceId });
    });
  }

  if (configureBtn) {
    configureBtn.addEventListener("click", () => {
      postToExtension({ type: "configureConnection" });
    });
  }

  function sendCurrentInput() {
    const text = String((inputEl && inputEl.value) || "").trim();
    if (!text) {
      return;
    }
    if (!state.selectedWorkspaceId) {
      return;
    }

    postToExtension({ type: "sendMessage", workspaceId: state.selectedWorkspaceId, text });

    if (inputEl) {
      inputEl.value = "";
    }
  }

  if (sendBtn) {
    sendBtn.addEventListener("click", sendCurrentInput);
  }

  if (inputEl) {
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendCurrentInput();
      }
    });
  }

  if (copyDebugBtn) {
    copyDebugBtn.addEventListener("click", () => {
      postToExtension({ type: "copyDebugLog", text: debugLines.join("\n") });
    });
  }

  // --- Error handlers

  window.addEventListener("error", (ev) => {
    appendDebug("window.error", { message: ev.message, filename: ev.filename, lineno: ev.lineno, colno: ev.colno });
    postToExtension({
      type: "debugLog",
      message: "window.error",
      data: { message: ev.message, filename: ev.filename, lineno: ev.lineno, colno: ev.colno },
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    appendDebug("unhandledrejection", { reason: String(ev.reason) });
    postToExtension({
      type: "debugLog",
      message: "unhandledrejection",
      data: { reason: String(ev.reason) },
    });
  });

  // --- Extension → webview messages

  let handshakeComplete = false;
  let readyAttempts = 0;

  const readyInterval = setInterval(() => {
    if (handshakeComplete) {
      return;
    }

    readyAttempts += 1;
    appendDebug("tx ready", { attempt: readyAttempts, reason: "retry" });
    postToExtension({ type: "ready" });
  }, 1000);

  function markHandshakeComplete(reason) {
    if (handshakeComplete) {
      return;
    }

    handshakeComplete = true;
    clearInterval(readyInterval);

    appendDebug("handshake complete", { reason, attempts: readyAttempts });
    postToExtension({ type: "debugLog", message: "handshake complete", data: { reason, attempts: readyAttempts } });
  }

  // Initial ready
  readyAttempts += 1;
  appendDebug("tx ready", { attempt: readyAttempts, reason: "initial" });
  postToExtension({ type: "ready" });

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object" || !msg.type) {
      return;
    }

    if (typeof msg.type === "string" && msg.type !== "chatEvent") {
      appendDebug(`rx ${msg.type}`, msg.__muxMeta);
    }

    if (msg.type === "debugProbe") {
      appendDebug("rx debugProbe", msg);
      setStatus(`mux webview: received debugProbe #${String(msg.attempt || "?")}`);
      postToExtension({ type: "debugLog", message: "rx debugProbe", data: msg });
      // Re-send ready in case the bridge came up late.
      postToExtension({ type: "ready" });
      return;
    }

    if (msg.type === "connectionStatus" || msg.type === "workspaces" || msg.type === "setSelectedWorkspace") {
      markHandshakeComplete(msg.type);
    }

    if (msg.type === "connectionStatus") {
      appendDebug("connectionStatus", msg.status);
      setConnectionStatus(msg.status);
      return;
    }

    if (msg.type === "workspaces") {
      state.workspaces = Array.isArray(msg.workspaces) ? msg.workspaces : [];
      appendDebug("workspaces updated", { count: state.workspaces.length });
      renderWorkspaces();
      return;
    }

    if (msg.type === "setSelectedWorkspace") {
      appendDebug("setSelectedWorkspace", { workspaceId: msg.workspaceId || null });
      state.selectedWorkspaceId = msg.workspaceId || null;
      if (workspaceSelectEl) {
        workspaceSelectEl.value = state.selectedWorkspaceId || "";
      }
      updateControls();
      return;
    }

    if (msg.type === "chatReset") {
      appendDebug("chatReset", { workspaceId: msg.workspaceId });
      resetChat();
      return;
    }

    if (msg.type === "chatEvent") {
      renderChatEvent(msg.event);
      return;
    }

    if (msg.type === "uiNotice") {
      appendDebug("uiNotice", { level: msg.level, message: msg.message });
      appendNotice(msg.level, msg.message);
      return;
    }
  });

  updateControls();
  renderWorkspaces();

  // Tell the extension host we booted.
  postToExtension({ type: "debugLog", message: "webview boot", data: { traceId } });
})();
