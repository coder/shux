#!/usr/bin/env node

// Keep the published `mux` package as a tiny forwarding boundary. The implementation
// stays entirely in `@coder/xum`, so the compatibility package can be retired without
// leaving duplicate CLI logic behind.
require("@coder/xum/dist/cli/index.js");
