# Next.js Server Actions & Forms

## Contents
- Server Actions (basic, using in forms)
- Form Actions Return Void (CRITICAL)
- useActionState for Feedback
- Optimistic Updates
- File Upload
- Validation with Zod
- Setting Cookies
- Redirect After Action
- useFormStatus
- Delete with Confirmation

---

## Server Actions

### Basic Server Action

```typescript
// app/actions.ts
'use server';

import { revalidatePath } from 'next/cache';

export async function createPost(formData: FormData) {
  const title = formData.get('title') as string;
  const content = formData.get('content') as string;

  await db.post.create({
    data: { title, content },
  });

  revalidatePath('/posts');
}
```

### Using in Form

```typescript
// app/posts/new/page.tsx
import { createPost } from '@/app/actions';

export default function NewPostPage() {
  return (
    <form action={createPost}>
      <input name="title" placeholder="Title" required />
      <textarea name="content" placeholder="Content" required />
      <button type="submit">Create Post</button>
    </form>
  );
}
```

## ⚠️ CRITICAL: Form Actions Return Void

When using `<form action={serverAction}>`, the function **MUST return void**.

```typescript
// ❌ WRONG - Will cause build error
export async function saveForm(formData: FormData) {
  'use server';
  await db.save(formData);
  return { success: true }; // ❌ ERROR!
}

// ✅ CORRECT - No return
export async function saveForm(formData: FormData) {
  'use server';
  await db.save(formData);
  revalidatePath('/');
  // No return statement
}
```

## useActionState for Feedback

```typescript
// actions.ts
'use server';

export async function createUser(
  prevState: { error?: string; success?: boolean } | null,
  formData: FormData
) {
  const email = formData.get('email') as string;

  if (!email.includes('@')) {
    return { error: 'Invalid email' };
  }

  await db.user.create({ data: { email } });
  return { success: true };
}

// Component
'use client';

import { useActionState } from 'react';
import { createUser } from './actions';

export default function SignupForm() {
  const [state, action, pending] = useActionState(createUser, null);

  return (
    <form action={action}>
      <input name="email" type="email" required />
      <button type="submit" disabled={pending}>
        {pending ? 'Creating...' : 'Sign Up'}
      </button>
      {state?.error && <p className="error">{state.error}</p>}
      {state?.success && <p className="success">Account created!</p>}
    </form>
  );
}
```

## Optimistic Updates

```typescript
'use client';

import { useOptimistic } from 'react';
import { addTodo } from './actions';

export default function TodoList({ todos }: { todos: Todo[] }) {
  const [optimisticTodos, addOptimisticTodo] = useOptimistic(
    todos,
    (state, newTodo: string) => [
      ...state,
      { id: Date.now(), text: newTodo, pending: true },
    ]
  );

  async function handleSubmit(formData: FormData) {
    const text = formData.get('text') as string;
    addOptimisticTodo(text);
    await addTodo(text);
  }

  return (
    <>
      <form action={handleSubmit}>
        <input name="text" required />
        <button type="submit">Add</button>
      </form>
      <ul>
        {optimisticTodos.map((todo) => (
          <li key={todo.id} style={{ opacity: todo.pending ? 0.5 : 1 }}>
            {todo.text}
          </li>
        ))}
      </ul>
    </>
  );
}
```

## Form with File Upload

```typescript
// actions.ts
'use server';

export async function uploadFile(formData: FormData) {
  const file = formData.get('file') as File;

  if (!file) {
    throw new Error('No file provided');
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  // Save to storage
  await saveToStorage(buffer, file.name);

  revalidatePath('/files');
}

// Component
export default function UploadForm() {
  return (
    <form action={uploadFile}>
      <input type="file" name="file" required />
      <button type="submit">Upload</button>
    </form>
  );
}
```

## Validation with Zod

```typescript
// actions.ts
'use server';

import { z } from 'zod';

const PostSchema = z.object({
  title: z.string().min(1, 'Title is required').max(100),
  content: z.string().min(10, 'Content must be at least 10 characters'),
});

export async function createPost(
  prevState: { errors?: Record<string, string[]> } | null,
  formData: FormData
) {
  const validatedFields = PostSchema.safeParse({
    title: formData.get('title'),
    content: formData.get('content'),
  });

  if (!validatedFields.success) {
    return {
      errors: validatedFields.error.flatten().fieldErrors,
    };
  }

  await db.post.create({
    data: validatedFields.data,
  });

  revalidatePath('/posts');
  redirect('/posts');
}
```

## Setting Cookies

```typescript
// actions.ts
'use server';

import { cookies } from 'next/headers';

export async function setTheme(theme: string) {
  const cookieStore = await cookies();
  cookieStore.set('theme', theme, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete('session');
  redirect('/login');
}
```

## Redirect After Action

```typescript
'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

export async function createPost(formData: FormData) {
  const post = await db.post.create({
    data: {
      title: formData.get('title') as string,
    },
  });

  revalidatePath('/posts');
  redirect(`/posts/${post.id}`);
}
```

## useFormStatus

```typescript
'use client';

import { useFormStatus } from 'react-dom';

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? 'Submitting...' : 'Submit'}
    </button>
  );
}

export default function Form() {
  return (
    <form action={submitAction}>
      <input name="data" required />
      <SubmitButton />
    </form>
  );
}
```

## Delete with Confirmation

```typescript
// actions.ts
'use server';

export async function deletePost(id: string) {
  await db.post.delete({ where: { id } });
  revalidatePath('/posts');
}

// Component
'use client';

import { deletePost } from './actions';

export function DeleteButton({ id }: { id: string }) {
  return (
    <form
      action={async () => {
        if (confirm('Are you sure?')) {
          await deletePost(id);
        }
      }}
    >
      <button type="submit">Delete</button>
    </form>
  );
}
```
