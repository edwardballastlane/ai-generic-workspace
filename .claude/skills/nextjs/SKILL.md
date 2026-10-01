---
name: nextjs
description: Next.js App Router patterns. Use when building Next.js 13+ apps, server/client components, routing, layouts, data fetching, Server Actions.
---

# Next.js App Router Patterns

## Reference Guide

| Topic | Reference | When |
|-------|-----------|------|
| Server/Client | [references/server-client.md](references/server-client.md) | Component type, useSearchParams, cookies |
| Routing | [references/routing.md](references/routing.md) | Layouts, route groups, dynamic routes |
| Data Fetching | [references/data-fetching.md](references/data-fetching.md) | Async, parallel fetching, caching |
| Forms | [references/forms.md](references/forms.md) | Server Actions, validation |

## Critical Rules

- **DEFAULT** is Server Component (no directive needed)
- **ONLY** add `'use client'` for hooks, events, or browser APIs
- **NEVER** use `any` type (causes build failures)
- **ALWAYS** wrap `useSearchParams` in Suspense
- **ALWAYS** fetch in parallel with `Promise.all()`

## Quick Decision

```
Need hooks/events/browser APIs? → 'use client'
Otherwise → Server Component (default)
```

## Gotchas

```typescript
// useSearchParams REQUIRES Suspense
<Suspense fallback={<Loading />}>
  <ComponentUsingSearchParams />
</Suspense>

// Next.js 15+ async params
const q = (await searchParams).q || '';

// Parallel fetch (NOT waterfall)
const [a, b] = await Promise.all([fetchA(), fetchB()]);

// Cookies/headers = Server only
import { cookies } from 'next/headers'; // Only in Server Components
```
