import { Window } from "happy-dom";

// The mobile React 19 tests must not load the desktop React 18 DOM harness.
const window = new Window();
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
