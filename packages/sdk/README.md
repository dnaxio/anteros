# @anteros/sdk

TypeScript REST client for the **Anteros** backend platform. Provides a typed, promise-based API to interact with your Anteros collections, services, files, and authentication endpoints — works in the browser, Node.js, and Bun.

## Installation

```bash
bun add @anteros/sdk
# or
npm install @anteros/sdk
```

> Requires `typescript` ^5 (peer dependency).

## Two clients, one transport

The package ships **two classes** over the same HTTP transport — pick the one that reads better, they can even be used side by side:

| Class | Surface |
| --- | --- |
| **`Anteros`** — `new Anteros({ server, tenant })` | **Namespaced** (recommended for new code): `api.collection(slug)`, `api.service(name).run`, `api.files`, `api.vars`, `api.agent(id)` |
| **`Rest`** — `new Rest({ server, tenant })` | **Flat**, unchanged: `api.find(collection, …)`, `api.upload(…)`, `api.runService(…)`, `api.login(…)`… |

**Nothing is deprecated and no call site has to move**: `Rest` keeps every method with the same signature (it simply talks to the server's current family URLs — the SDK builds the paths), while `Anteros` groups those same calls per family. `vars`, `agent(id)`, `getConfig()` and the header/token methods are shared by both.

## Quick start

```ts
import { Anteros } from "@anteros/sdk";

const api = new Anteros({
  server: "https://api.example.com",
  tenant: "my-tenant",
  token: {
    persist: true,        // auto-save token in localStorage
    storageKey: "anteros_token",
  },
});

// Login (an auth-enabled collection)
const users = api.collection("users");
const { token, data: user } = await users.login({
  email: "john@example.com",
  password: "secret",
});

// CRUD — the slug is stated once, the row type once
const posts = api.collection<Post>("posts");
const page = await posts.find({ $limit: 10 });
const post = await posts.insertOne({ title: "Hello" });
await posts.updateOne(post._id, { $set: { title: "Updated" } });
await posts.deleteOne(post._id);
```

The same thing with the original client, unchanged:

```ts
import { Rest } from "@anteros/sdk";

const api = new Rest({ server: "https://api.example.com", tenant: "my-tenant" });

const { token } = await api.login("users", { email, password });
const page = await api.find("posts", { $limit: 10 });
const post = await api.insertOne("posts", { title: "Hello" });
await api.updateOne("posts", post._id, { $set: { title: "Updated" } });
```

## API reference

### Constructor

```ts
new Anteros(options: RestClientOptions)   // namespaced
new Rest(options: RestClientOptions)      // flat (same options)
```

| Option             | Type                      | Description |
|-------------------|--------------------------|-------------|
| `server`          | `string`                 | Base URL of the Anteros server |
| `tenant`          | `string`                 | Tenant identifier |
| `headers`         | `Record<string, string>` | Default headers sent with every request |
| `token`           | `object`                 | Token persistence settings |
| `token.persist`   | `boolean`                | Persist token in `localStorage` (default: `true`) |
| `token.storageKey`| `string`                 | localStorage key (default: `"anteros_token"`) |

### Collections (CRUD)

With **`Anteros`**, the collection is bound once and the row type is given with it:

```ts
const posts = api.collection<Post>("posts");

await posts.find({ $limit: 10 });
await posts.findOne(id);
await posts.insertOne({ title: "Hello" });
await posts.aggregate([{ $group: { _id: "$author" } }]);
await posts.runAction("publish", { at });
```

With **`Rest`**, every method takes the collection first — the signatures are unchanged:

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

```ts
// Anteros — the collection owns its auth actions
const users = api.collection("users");
const { token } = await users.login({ email, password });
await users.logout();

// Rest — unchanged
const { token } = await api.login("users", { email, password });
await api.logout("users");
```

Both clients drive their instance's token: shared by every later call of that instance.

| Method                                           | Description |
|-------------------------------------------------|-------------|
| `login(...)`                                     | Login and automatically store the JWT token |
| `logout(...)`                                    | Logout and clear the stored token |
| `getToken()`                                    | Get the current token |
| `clearToken()`                                  | Manually clear the token |
| `setHeader(name, value)`                        | Set/unset a custom header |

### File management

```ts
// Anteros — the files family
const file = await api.files.upload("photos", blob, { title: "My photo" }, { fieldName: "file" });
const url = api.files.url("photos", file._file.filename, { width: 400, format: "webp" });
await api.files.delete("photos", file._id);

// Rest — unchanged
const result = await api.upload("photos", blob, { title: "My photo" }, { fieldName: "file" });
const legacyUrl = api.getFileUrl("photos", "abc123.jpg", { width: 400, height: 300, format: "webp", quality: 80 });
await api.deleteFile("photos", result._id);
```

### Services

```ts
// Anteros
const report = await api.service("email").run("send", { to: "user@example.com" });

// Rest — unchanged
const legacy = await api.runService("email", "send", { to: "user@example.com" });
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
