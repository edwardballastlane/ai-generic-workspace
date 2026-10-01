# Next.js Data Fetching

## Contents
- Server Components Data Fetching
- Parallel Data Fetching
- Streaming with Suspense
- Caching (no-store, revalidate, tags)
- React 'use' API
- Database Queries
- Dynamic Rendering
- Error Handling
- Route Segment Config

---

## Server Components Data Fetching

Fetch data directly in Server Components:

```typescript
// app/users/page.tsx
export default async function UsersPage() {
  const response = await fetch('https://api.example.com/users');
  const users = await response.json();

  return (
    <ul>
      {users.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}
```

## Parallel Data Fetching

```typescript
// ✅ CORRECT - Parallel (fast)
export default async function Dashboard() {
  const [user, posts, comments] = await Promise.all([
    fetchUser(),
    fetchPosts(),
    fetchComments(),
  ]);

  return (
    <div>
      <UserInfo user={user} />
      <Posts posts={posts} />
      <Comments comments={comments} />
    </div>
  );
}

// ❌ WRONG - Waterfall (slow)
export default async function Dashboard() {
  const user = await fetchUser();
  const posts = await fetchPosts(); // Waits for user
  const comments = await fetchComments(); // Waits for posts

  return <div>...</div>;
}
```

## Streaming with Suspense

```typescript
import { Suspense } from 'react';

export default function Page() {
  return (
    <div>
      <h1>Dashboard</h1>

      <Suspense fallback={<StatsSkeleton />}>
        <Stats />
      </Suspense>

      <Suspense fallback={<FeedSkeleton />}>
        <Feed />
      </Suspense>
    </div>
  );
}

async function Stats() {
  const data = await fetchStats(); // Slow query
  return <div>{data.total}</div>;
}

async function Feed() {
  const items = await fetchFeed(); // Fast query
  return <ul>{items.map(i => <li key={i.id}>{i.title}</li>)}</ul>;
}
```

## Caching

```typescript
// Default: cached
const data = await fetch('https://api.example.com/data');

// No cache
const data = await fetch('https://api.example.com/data', {
  cache: 'no-store',
});

// Revalidate every 60 seconds
const data = await fetch('https://api.example.com/data', {
  next: { revalidate: 60 },
});

// Revalidate on demand with tags
const data = await fetch('https://api.example.com/data', {
  next: { tags: ['posts'] },
});

// Then revalidate from Server Action
import { revalidateTag } from 'next/cache';
revalidateTag('posts');
```

## React 'use' API

Pass promises from Server to Client Components:

```typescript
// Server Component
import { Suspense } from 'react';
import UserProfile from './UserProfile';

export default function Page() {
  const userPromise = fetchUser(); // Don't await

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <UserProfile userPromise={userPromise} />
    </Suspense>
  );
}

// Client Component
'use client';

import { use } from 'react';

export default function UserProfile({
  userPromise
}: {
  userPromise: Promise<{ name: string; email: string }>
}) {
  const user = use(userPromise); // Unwrap promise
  return <div>{user.name}</div>;
}
```

## Database Queries

```typescript
// app/posts/page.tsx
import { db } from '@/lib/db';

export default async function PostsPage() {
  const posts = await db.post.findMany({
    orderBy: { createdAt: 'desc' },
    include: { author: true },
  });

  return (
    <ul>
      {posts.map((post) => (
        <li key={post.id}>
          {post.title} by {post.author.name}
        </li>
      ))}
    </ul>
  );
}
```

## Dynamic Rendering

```typescript
// Force dynamic rendering
export const dynamic = 'force-dynamic';

// Or use dynamic functions
import { cookies, headers } from 'next/headers';

export default async function Page() {
  const cookieStore = await cookies(); // Makes page dynamic
  return <div>...</div>;
}
```

## Error Handling

```typescript
export default async function Page() {
  const response = await fetch('https://api.example.com/data');

  if (!response.ok) {
    throw new Error('Failed to fetch data');
  }

  const data = await response.json();
  return <div>{data.content}</div>;
}

// error.tsx will catch the error
```

## Route Segment Config

```typescript
// app/posts/page.tsx

// Caching behavior
export const revalidate = 60; // Revalidate every 60 seconds
export const dynamic = 'force-dynamic'; // Always dynamic
export const dynamic = 'force-static'; // Always static

// Runtime
export const runtime = 'nodejs'; // Default
export const runtime = 'edge'; // Edge runtime

// Preferred region
export const preferredRegion = 'auto';
export const preferredRegion = ['iad1', 'sfo1'];
```
