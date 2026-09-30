# Start here

This is the implemented Minesweeper vs JEV project, not only a planning document.

1. Open a terminal in this folder with Node.js22.16.0 or later installed.
2. Run `npm start` (a local development shim; production is Cloudflare Workers + D1, see docs/DEPLOYMENT.md).
3. Open `http://localhost:3000`, select New game, and choose your starting cell.

No npm install or API credentials are needed for explicitly labeled local-opponent practice. To enable actual JEV and Discord, copy `.env.example` to `.env` and follow README.md / docs/DEPLOYMENT.md. No credentials are included.

The reports folder contains test output, local benchmark measurements, UI screenshots, and synthetic analytics examples. Live provider and Discord configuration still require staging validation. Read docs/ANALYTICS.md for definitions and interpretation limits; active-board hidden information is never included in live analytics.
