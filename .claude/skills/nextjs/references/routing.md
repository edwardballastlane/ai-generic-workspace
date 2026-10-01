# Next.js App Router Routing

## Contents
- File Conventions (page, layout, loading, error, not-found)
- Layouts (root, nested)
- Dynamic Routes
- Route Groups
- Parallel Routes
- Intercepting Routes
- Route Handlers (API)
- Loading States
- Error Handling
- Not Found
- Metadata

---

## File Conventions

```
app/
├── layout.tsx      # Root layout (required)
├── page.tsx        # Route: /
├── loading.tsx     # Loading UI with Suspense
├── error.tsx       # Error boundary
├── not-found.tsx   # 404 UI
├── template.tsx    # Re-renders on navigation
├── route.ts        # API endpoint
└── blog/
    ├── layout.tsx  # Nested layout
    ├── page.tsx    # Route: /blog
    └── [slug]/
        └── page.tsx # Dynamic: /blog/:slug
```

## Layouts

Layouts wrap pages and preserve state across navigation:

```typescript
// app/layout.tsx (Root Layout - Required)
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Header />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}

// app/dashboard/layout.tsx (Nested Layout)
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dashboard">
      <Sidebar />
      <div className="content">{children}</div>
    </div>
  );
}
```

## Dynamic Routes

```typescript
// app/blog/[slug]/page.tsx
export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPost(slug);

  return <article>{post.title}</article>;
}

// Generate static params
export async function generateStaticParams() {
  const posts = await getPosts();
  return posts.map((post) => ({ slug: post.slug }));
}
```

## Route Groups

Organize routes without affecting URL:

```
app/
├── (marketing)/
│   ├── about/page.tsx    # /about
│   └── contact/page.tsx  # /contact
├── (shop)/
│   ├── products/page.tsx # /products
│   └── cart/page.tsx     # /cart
└── (auth)/
    ├── login/page.tsx    # /login
    └── register/page.tsx # /register
```

## Parallel Routes

Render multiple pages in same layout:

```
app/
├── layout.tsx
├── @team/page.tsx     # Named slot
├── @analytics/page.tsx # Named slot
└── page.tsx
```

```typescript
// app/layout.tsx
export default function Layout({
  children,
  team,
  analytics,
}: {
  children: React.ReactNode;
  team: React.ReactNode;
  analytics: React.ReactNode;
}) {
  return (
    <div>
      {children}
      <div className="sidebar">
        {team}
        {analytics}
      </div>
    </div>
  );
}
```

## Intercepting Routes

Intercept routes to show modals:

```
app/
├── feed/
│   └── page.tsx
├── photo/[id]/
│   └── page.tsx
└── @modal/
    └── (.)photo/[id]/   # Intercept /photo/[id]
        └── page.tsx
```

Convention:
- `(.)` - Same level
- `(..)` - One level up
- `(..)(..)` - Two levels up
- `(...)` - From root

## Route Handlers (API)

```typescript
// app/api/users/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('query');

  const users = await getUsers(query);
  return NextResponse.json(users);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const user = await createUser(body);

  return NextResponse.json(user, { status: 201 });
}
```

## Loading States

```typescript
// app/dashboard/loading.tsx
export default function Loading() {
  return <div className="skeleton">Loading...</div>;
}
```

## Error Handling

```typescript
// app/dashboard/error.tsx
'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div>
      <h2>Something went wrong!</h2>
      <button onClick={() => reset()}>Try again</button>
    </div>
  );
}
```

## Not Found

```typescript
// app/not-found.tsx
export default function NotFound() {
  return (
    <div>
      <h2>Not Found</h2>
      <p>Could not find the requested resource</p>
    </div>
  );
}

// Trigger programmatically
import { notFound } from 'next/navigation';

export default async function Page({ params }: { params: { id: string } }) {
  const item = await getItem(params.id);

  if (!item) {
    notFound();
  }

  return <div>{item.name}</div>;
}
```

## Metadata

```typescript
// Static metadata
export const metadata = {
  title: 'My App',
  description: 'Welcome to my app',
};

// Dynamic metadata
export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}) {
  const post = await getPost(params.slug);

  return {
    title: post.title,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      images: [post.image],
    },
  };
}
```
