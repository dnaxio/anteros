# @anteros/sdk

TypeScript REST client for the **Anteros** backend platform. Provides a typed, promise-based API to interact with your Anteros collections, services, files, and authentication endpoints — works in the browser, Node.js, and Bun.

## Installation

```bash
bun add @anteros/sdk
# or
npm install @anteros/sdk
```

> Requires `typescript` ^5 (peer dependency).

## Quick start

```ts
import { Rest } from "@anteros/sdk";

const api = new Rest({
  server: "https://api.example.com",
  tenant: "my-tenant",
  token: {
    persist: true,        // auto-save token in localStorage
    storageKey: "dnax_token",
  },
});

// Login
const { token, data: user } = await api.login("users", {
  email: "john@example.com",
  password: "secret",
});

// CRUD
const posts = await api.find("posts", { $limit: 10 });
const post  = await api.insertOne("posts", { title: "Hello" });
await api.updateOne("posts", post._id, { title: "Updated" });
await api.deleteOne("posts", post._id);
```

## API reference

### Constructor

```ts
new Rest(options: RestClientOptions)
```

| Option             | Type                      | Description |
|-------------------|--------------------------|-------------|
| `server`          | `string`                 | Base URL of the Anteros server |
| `tenant`          | `string`                 | Tenant identifier |
| `headers`         | `Record<string, string>` | Default headers sent with every request |
| `token`           | `object`                 | Token persistence settings |
| `token.persist`   | `boolean`                | Persist token in `localStorage` (default: `true`) |
| `token.storageKey`| `string`                 | localStorage key (default: `"dnax_token"`) |

### Collections (CRUD)

All collection methods follow the pattern `method<T>(collection, …)` where `T` is the return type.

| Method                                               | Description |
|-----------------------------------------------------|-------------|
| `find<T>(collection, params, options?)`              | Query documents with filters, sorting, pagination, lookups |
| `findOne<T>(collection, id, params?, options?)`     | Get a single document by ID |
| `insertOne<T, TBody>(collection, data, options?)`   | Insert one document |
| `insertMany<T, TBody>(collection, data[], options?)`| Insert multiple documents |
| `updateOne<T, TUpdate>(collection, id, update, options?)` | Update one document |
| `updateMany<TUpdate>(collection, ids[], update, options?)` | Update multiple documents |
| `deleteOne(collection, id, options?)`               | Delete one document |
| `deleteMany(collection, ids[], options?)`            | Delete multiple documents |
| `aggregate<T>(collection, pipeline, options?)`      | Run an aggregation pipeline |
| `runAction<T>(collection, action, data?, options?)`  | Call a custom collection action |

#### `FindOptions`

```ts
{
  $limit?: number;
  $skip?: number;
  $sort?: { [key: string]: 1 | -1 };
  $match?: Record<string, unknown>;
  $project?: Record<string, unknown>;
  $include?: Array<string | LookupOptions>;
  $lookup?: Array<Record<string, any>>;
  $graphLookup?: Array<Record<string, any>>;
}
```

### Authentication

| Method                                           | Description |
|-------------------------------------------------|-------------|
| `login<T>(collection, payload, options?)`        | Login and automatically store the JWT token |
| `logout<T>(collection, payload?, options?)`     | Logout and clear the stored token |
| `getToken()`                                    | Get the current token |
| `clearToken()`                                  | Manually clear the token |
| `setHeader(name, value)`                        | Set/unset a custom header |

### File management

```ts
// Upload one or more files
const result = await api.upload("photos", file, { title: "My photo" }, {
  fieldName: "file",  // default
});

// Get a file URL with optional image transform
const url = api.getFileUrl("photos", "abc123.jpg", {
  width: 400,
  height: 300,
  format: "webp",
  quality: 80,
});

// Delete a file
await api.deleteFile("photos", "abc123.jpg");
```

### Services

```ts
const result = await api.runService("email", "send", {
  to: "user@example.com",
  subject: "Hello",
});
```

### Configuration

```ts
const config = await api.getConfig();
// { tenants, collections, services, fileCollections }
```

### Request options

Every method accepts optional `RestRequestOptions`:

```ts
{
  headers?: Record<string, string>;   // extra headers
  signal?: AbortSignal;               // support for AbortController
  query?: RestQueryOptions;           // query params
  cleanDeep?: boolean;                // strip null/empty values from body
}
```

## Utility: cleanDeep

The SDK exports a `cleanDeep` utility that recursively removes `null`, `undefined`, empty arrays, and empty objects from a value.

## License

MIT
