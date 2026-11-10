# CLAUDE.md

Guidance for agents working in this repository.

## Commands

- `npm run dev` — development server on <http://localhost:3000>
- `npm run build` — production build (webpack; Turbopack's native binding is blocked on some Windows hosts)
- `npm start` — serve the production build
- `npm run lint` / `npm run typecheck`
- `npm test` / `npm run test:coverage`
- `npm run audit:prod` — production dependency audit (must stay clean)

Run the full gate with:

```bash
npm run lint && npm run typecheck && npm test -- --ci && npm run build
```

Docker gate (Linux, matches CI):

```bash
docker run --rm -v "$PWD:/app" -v gwm_node_modules:/app/node_modules \
  -w /app node:24-alpine sh -c "npm ci && npm run lint && npm run typecheck && npm test -- --ci && npm run build"
```

## Architecture

Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, shadcn/ui on Radix.
The app is client-only: there is no API route and no server-side token handling.

Context hierarchy in `src/app/layout.tsx`:

`Theme → DisplaySettings → GitHubToken → RepositorySelection → Workflow`

- `src/contexts/github-token-context.tsx` — validates the PAT, stores it
  encrypted, exposes `userId`, `scopes`, `rateLimit`.
- `src/contexts/repository-selection-context.tsx` — organizations, repository
  list, per-repository workflow activity, persisted selection.
- `src/contexts/workflow-context.tsx` — one `actions/runs` request per
  repository; derives per-workflow histories and repository metrics; auto-refresh
  with jitter and a concurrency cap.
- `src/lib/api/github.ts` — the only GitHub API client. Validates and encodes
  owner/repo names, sets timeouts, retries idempotent failures, captures scopes
  and rate limits.
- `src/lib/workflow-metrics.ts` — pure timing/health calculations. Add tests here
  whenever the formulas change.
- `src/components/workflow-stats.tsx` — fleet strip, live runtime/queue badges,
  repository health line.
- `src/lib/storage/secure-storage.ts` — AES-256-GCM with an HKDF key derived from
  a random IndexedDB secret. Never persist a token in plaintext.

## Conventions

- Prefer React text interpolation; do not add `dangerouslySetInnerHTML`.
- Any new network host must be added to `connect-src` in `next.config.ts` and
  justified in the PR.
- External links need `rel="noopener noreferrer"`.
- Tests live in `__tests__/` and must match `*.test.ts(x)`. Do not add standalone
  scripts that call `process.exit` there.
- The Docker image must stay non-root and keep working with a read-only root
  filesystem.
- Security-relevant changes also update `docs/SECURITY-AUDIT.md`.
