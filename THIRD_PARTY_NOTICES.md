# Third-party notices

This project has no runtime dependencies. The following third-party assets are vendored into the repository.

## Inter

- License: SIL Open Font License 1.1
- Copyright (c) 2016 The Inter Project Authors
- Vendored at: `public/brand/inter-var.woff2`
- License text: `public/brand/OFL.txt`

## VT323

- License: SIL Open Font License 1.1
- Copyright 2011, The VT323 Project Authors
- Vendored at: `public/brand/vt323.woff2` (shared jevplay.games brand file)
- License text: `public/brand/OFL-VT323.txt`

## @discord/embedded-app-sdk

- Version: 2.5.0
- License: MIT
- Copyright (c) Discord Inc.
- Vendored (bundled) at: `public/vendor/discord-embedded-app-sdk.js`
- Loaded only when the page is opened as a Discord Activity (URL carries `frame_id`); served same-origin because the CSP allows scripts from `'self'` only.
