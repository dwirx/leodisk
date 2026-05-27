# Repository Guidelines

## Project Structure & Module Organization

LeoDisk is a Windows maintenance app built with React, Vite, TypeScript, and Tauri 2.

- `src/` contains the React UI. `App.tsx` coordinates pages and Tauri calls, `components.tsx` holds shared UI primitives, `types.ts` defines frontend data contracts, and `App.css` contains app styling.
- `src/test/setup.ts` configures Vitest and Testing Library. Component tests live beside source files, for example `src/App.test.tsx`.
- `src-tauri/src/` contains the Rust backend modules for cleanup, app inventory, disk scanning, system metrics, storage, startup items, and utilities.
- `src-tauri/capabilities/` and `src-tauri/tauri.conf.json` define Tauri permissions and app configuration.
- `public/` and `src-tauri/icons/` hold static assets. Treat `dist/`, `node_modules/`, and `src-tauri/target/` as generated output.

## Build, Test, and Development Commands

Use Bun for frontend commands:

- `bun install` installs JavaScript dependencies from `bun.lock`.
- `bun run dev` starts the Vite frontend on port `1420`.
- `bun run tauri dev` launches the full desktop app with the Rust backend.
- `bun run build` runs `tsc` and creates the production Vite build.
- `bun run test` runs Vitest once in jsdom.
- `cd src-tauri && cargo test` runs Rust backend tests.

## Coding Style & Naming Conventions

TypeScript is strict (`noUnusedLocals`, `noUnusedParameters`, `strict`). Use React function components, typed props, and `PascalCase` for components. Use `camelCase` for variables, functions, and Tauri command wrappers. Keep imports grouped by external packages, local components, local types, then CSS.

Rust uses standard `rustfmt` style with four-space indentation and `snake_case` modules/functions. Keep Tauri command names stable because the frontend invokes them by string.

## Testing Guidelines

Frontend tests use Vitest, jsdom, and Testing Library. Name tests `*.test.tsx` and prefer user-visible assertions (`getByRole`, `getByText`) over implementation details. Mock Tauri APIs when testing UI flows. For Rust, add unit tests near backend logic where practical and run `cargo test` before changing cleanup, deletion, scan, or Windows integration behavior.

## Commit & Pull Request Guidelines

This checkout does not include Git history, so follow a simple imperative convention such as `Add disk scan cancellation test` or `Fix cleanup selection state`. Pull requests should describe user-visible behavior, list verification commands, link related issues, and include screenshots or short clips for UI changes.

## Security & Configuration Tips

LeoDisk intentionally avoids administrator-only cleanup, registry deletion, and service modification. Preserve explicit confirmations for destructive actions, report skipped or inaccessible paths honestly, and keep Tauri permissions limited to the commands and plugins the app actually uses.
