import { Client } from "./client";
import { Collection } from "./collection";
import { Files } from "./files";
import { Service } from "./service";

/**
 * The **namespaced** client — the recommended surface for new code.
 *
 * Everything lives in its own space, mirroring the server's URL families
 * (`/api/:tenant/<family>/…`): a **singular** member is a client bound to one
 * resource, a **plural** one is that family's operations.
 *
 * ```ts
 * import { Anteros } from '@anteros/sdk';
 *
 * const api = new Anteros({ server: 'http://localhost:4000', tenant: 'v1' });
 *
 * const orders = api.collection<Order>('orders');
 * const paid = await orders.find({ $match: { status: 'paid' } });
 * await orders.updateOne(paid[0]._id, { $set: { status: 'shipped' } });
 *
 * await api.files.upload('photos', file);
 * await api.service('analytics').run('monthly', { month: '2026-09' });
 * await api.vars.set('config', 'licence', 'RDX00');
 * ```
 *
 * The original, flat client is [`Rest`](./rest): it keeps `find(collection, …)`,
 * `upload(…)`, `runService(…)`… untouched, so existing code never has to move.
 * Both share the transport (URL, headers, token, error shape) and the shared
 * members (`vars`, `agent(id)`, `getConfig()`, headers, token).
 */
class Anteros extends Client {
    /**
     * One collection of the tenant — the slug (and its row type) is stated once.
     *
     * ```ts
     * const orders = api.collection<Order>('orders');
     * await orders.find({ $match: { status: 'paid' } });
     * await orders.insertOne({ ref: 'A-1' });
     * const { token } = await orders.login({ email, password });
     * ```
     */
    collection<T = any>(slug: string): Collection<T> {
        return new Collection<T>(
            slug,
            (action, body, options) =>
                this.postJson<any>(this.buildUrl(slug, action, options?.query), body, options ?? {}),
            {
                defaults: this.defaultParams,
                onToken: (token) => this.setToken(token),
            },
        );
    }

    /**
     * File collections — `upload`, `url`, `delete`.
     *
     * ```ts
     * const file = await api.files.upload('photos', input.files[0], { alt: 'Cover' });
     * api.files.url('photos', file._file.filename, { width: 400 });
     * await api.files.delete('photos', file._id);
     * ```
     */
    get files(): Files {
        return new Files(
            (collection, formData, signal) => this.postForm(this.buildUploadUrl(collection), formData, signal),
            (collection, filename) => this.buildFileUrl(collection, filename),
            (url, signal) => this.remove(url, signal),
        );
    }

    /**
     * One service of the tenant — the name is stated once, on the client.
     *
     * ```ts
     * const analytics = api.service('analytics');
     * await analytics.run('generateReport', { from, to });
     * ```
     */
    service<T = any>(name: string): Service<T> {
        return new Service<T>(name, (action, body, options) =>
            this.postJson<any>(this.buildServiceUrl(name, action, options?.query), body, options));
    }
}

export { Anteros };
