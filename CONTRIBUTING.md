# Contributing to Yeaft WebChat

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/yeaft/webchat.git
cd webchat
npm install
npm run dev
```

Open `http://localhost:3456` — dev mode skips authentication.

## Project Structure

- `server/` — Central WebSocket server (Express + ws)
- `agent/` — Worker machine agent (manages Claude CLI)
- `web/` — Vue 3 frontend (no build step in dev)

## Running Tests

```bash
npm test
```

264 tests covering server, agent, and integration scenarios.

## Building Frontend

```bash
npm run build
```

Bundles `web/` into `web/dist/` via esbuild. Docker builds do this automatically.

## Pull Requests

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Ensure `npm test` passes
4. Ensure `npm run build` succeeds
5. Submit a PR with a clear description

## Reporting Issues

Use [GitHub Issues](https://github.com/yeaft/webchat/issues). Include:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

## Code Style

- ES Modules (`import`/`export`) throughout
- No build step for web in development — browser-native ES modules
- CSS variables for all colors (both themes must work)
- Inline SVGs for icons (`fill="currentColor"`)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
