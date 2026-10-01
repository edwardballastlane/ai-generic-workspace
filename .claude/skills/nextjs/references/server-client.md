# Server Components vs Client Components

## Contents
- Core Decision: Server vs Client
- Cookies & Headers (Server Only)
- useSearchParams Requires Suspense
- Async Params (Next.js 15+)
- Navigation Patterns
- Composition Pattern
- Anti-Patterns

---

## Core Decision: Server vs Client

### Default: Server Components

All components are Server Components by default. No directive needed.

```typescript
// Server Component (default) - can be async
export default async function ProductList() {
  const products = await fetch('https://api.example.com/products');
  const data = await products.json();
  return <ul>{data.map(p => <li key={p.id}>{p.name}</li>)}</ul>;
}
```

**Use Server Components for:**
- Fetching data from APIs or databases
- Accessing backend resources (env vars, file system)
- Processing sensitive information (API keys, tokens)
- Reducing client-side JavaScript bundle
- SEO-critical content

### Client Components: 'use client'

Add `'use client'` at the top of file only when needed:

```typescript
'use client';

import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}
```

**Use Client Components for:**
- React hooks (useState, useEffect, useContext)
- Event handlers (onClick, onChange, onSubmit)
- Browser APIs (window, localStorage, navigator)
- Third-party libraries requiring browser

## Cookies & Headers (Server Only)

```typescript
import { cookies, headers } from 'next/headers';

export default async function Page() {
  const cookieStore = await cookies();
  const token = cookieStore.get('session-token');

  const headersList = await headers();
  const userAgent = headersList.get('user-agent');

  if (!token) {
    redirect('/login');
  }

  return <div>Welcome</div>;
}
```

## useSearchParams ALWAYS Requires Suspense

```typescript
// Parent component
import { Suspense } from 'react';
import SearchComponent from './SearchComponent';

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SearchComponent />
    </Suspense>
  );
}

// SearchComponent.tsx
'use client';

import { useSearchParams } from 'next/navigation';

export default function SearchComponent() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q');
  return <div>Search query: {query}</div>;
}
```

## Async Params (Next.js 15+)

```typescript
// app/search/page.tsx
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // BEST PRACTICE: Inline access
  const q = (await searchParams).q || '';
  return <div>Search: {q}</div>;
}
```

## Navigation Patterns

**Server Navigation (No 'use client' needed):**
- `<Link>` from `next/link`
- `redirect()` from `next/navigation`
- Server Actions

**Client Navigation (Requires 'use client'):**
- `useRouter()` hook
- `usePathname()` hook
- `useSearchParams()` hook (+ Suspense)

```typescript
// Server Component - NO 'use client' needed!
import Link from 'next/link';
import { redirect } from 'next/navigation';

export default async function Page() {
  const data = await fetchData();

  if (!data) {
    redirect('/login');  // Server-side redirect
  }

  return (
    <div>
      <Link href="/dashboard">Go to Dashboard</Link>
    </div>
  );
}
```

## Composition Pattern

Pass Server Components as children to Client Components:

```typescript
// page.tsx (Server Component)
import ClientWrapper from './ClientWrapper';
import ServerContent from './ServerContent';

export default function Page() {
  return (
    <ClientWrapper>
      <ServerContent />
    </ClientWrapper>
  );
}

// ClientWrapper.tsx
'use client';

import { useState } from 'react';

export default function ClientWrapper({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div>
      <button onClick={() => setIsOpen(!isOpen)}>Toggle</button>
      {isOpen && children}
    </div>
  );
}

// ServerContent.tsx (Server Component)
export default async function ServerContent() {
  const data = await fetchData();
  return <div>{data.content}</div>;
}
```

## Anti-Patterns

### ❌ Using 'use client' Everywhere

```typescript
// ❌ WRONG - Unnecessary
'use client';
export default function Header() {
  return <header><h1>My App</h1></header>;
}

// ✅ CORRECT
export default function Header() {
  return <header><h1>My App</h1></header>;
}
```

### ❌ Fetching Data in Client Components

```typescript
// ❌ WRONG
'use client';
import { useState, useEffect } from 'react';

export default function Products() {
  const [products, setProducts] = useState([]);
  useEffect(() => {
    fetch('/api/products').then(r => r.json()).then(setProducts);
  }, []);
  return <div>...</div>;
}

// ✅ CORRECT
export default async function Products() {
  const response = await fetch('https://api.example.com/products');
  const products = await response.json();
  return <div>{products.map(p => <div key={p.id}>{p.name}</div>)}</div>;
}
```

### ❌ Importing Server APIs in Client Components

```typescript
// ❌ WRONG - Will fail
'use client';
import { cookies } from 'next/headers'; // ERROR!

// ✅ CORRECT - Pass data from Server Component
// ServerComponent.tsx
import { cookies } from 'next/headers';
import ClientComponent from './ClientComponent';

export default async function ServerComponent() {
  const cookieStore = await cookies();
  const token = cookieStore.get('token')?.value;
  return <ClientComponent token={token} />;
}
```
