import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";
import { resolve } from "../utils/crypto";

const TENANT = "enc-test";
const DB = "mongodb://localhost:27017/_DB_ENC_TEST";

let rest: InstanceType<typeof useRest>;

function encCollection(fields: any[]) {
    return { _tenant_: TENANT, slug: "patients", fields, api: { access: { "*": true } } };
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000, encryption: { mode: "symmetric", secret: "field-enc-secret" } },
        tenants: [{ id: TENANT, dir: "enc-tenant", database: { uri: DB } }],
    });
    await syncTenants();
    await syncCollections();
    (cfg as any).collections = [encCollection([
        { name: "name", type: "string" },
        { name: "ssn", type: "string", encryption: true },           // whole value encrypted
        { name: "profile", type: "json", encryption: true },          // whole json encrypted
        { name: "age", type: "number" },
        { name: "address", type: "json", encryptionOptions: { path: "zip" } },          // json: only address.zip encrypted
        { name: "contacts", type: "json", encryptionOptions: { path: ["phone", "email"] } }, // several paths
        { name: "addresses", type: "json", encryptionOptions: { path: "zip" } },        // array of json
    ])];
    rest = new useRest({ internal: false, tenant_id: TENANT });
});

afterAll(async () => {
    delete (cfg.server as any).encryption;
    formatConfig({ server: { port: 4000 }, tenants: [] });
    try { await rest.db.collection("patients").drop(); } catch {}
});

describe("field-level encryption", () => {
    it("insert stores ciphertext in Mongo but returns plaintext", async () => {
        const doc: any = await rest.insertOne("patients", { name: "John", ssn: "123-45-6789", profile: { city: "Paris", zip: 75000 }, age: 42 });

        // API response = plaintext
        expect(doc.ssn).toBe("123-45-6789");
        expect(doc.profile).toEqual({ city: "Paris", zip: 75000 });

        // in Mongo = ciphertext (version byte + IV + data)
        const raw = await rest.db.collection("patients").findOne({ _id: new ObjectId(doc._id) });
        expect(raw).not.toBeNull();
        expect(raw!.ssn).not.toBe("123-45-6789");
        expect(typeof raw!.ssn).toBe("string");
        expect(raw!.ssn).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
        expect(raw!.profile).not.toEqual({ city: "Paris" });
        // non-encrypted field untouched
        expect(raw!.name).toBe("John");
        expect(raw!.age).toBe(42);
    });

    it("find / findOne return ciphertext (no decrypt on output)", async () => {
        const list: any = await rest.find("patients", { $match: { name: "John" } });
        // read = ciphertext (never decrypted automatically)
        expect(list[0].ssn).not.toBe("123-45-6789");
        expect(list[0].ssn).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(list[0].profile).not.toEqual({ city: "Paris", zip: 75000 });
        // non-encrypted fields untouched
        expect(list[0].name).toBe("John");

        const one: any = await rest.findOne("patients", list[0]._id);
        expect(one.ssn).toMatch(/^[A-Za-z0-9+/=]+$/);

        // explicit MANUAL decryption (utils.crypt.resolve())
        const cipher = resolve();
        const dec = await cipher.decrypt<string>(one.ssn, true);
        expect(dec).toBe("123-45-6789");
    });

    it("update via $set encrypts the new value (returns ciphertext)", async () => {
        const doc: any = await rest.findOne("patients", (await rest.find("patients", { $match: { name: "John" } }))[0]!._id);
        const updated: any = await rest.updateOne("patients", doc._id, { $set: { ssn: "987-65-4321" } });

        // response = ciphertext (no automatic decryption anymore)
        expect(updated.ssn).not.toBe("987-65-4321");
        expect(updated.ssn).toMatch(/^[A-Za-z0-9+/=]+$/);
        // stored = new ciphertext
        const raw = await rest.db.collection("patients").findOne({ _id: new ObjectId(doc._id) });
        expect(raw).not.toBeNull();
        expect(raw!.ssn).not.toBe("987-65-4321");
    });

    it("insertMany encrypts every doc", async () => {
        await rest.insertMany("patients", [
            { name: "A", ssn: "111-11-1111" },
            { name: "B", ssn: "222-22-2222" },
        ]);
        const raw = await rest.db.collection("patients").find({ name: { $in: ["A", "B"] } }).toArray();
        for (const r of raw) expect(r.ssn).toMatch(/^[A-Za-z0-9+/=]+$/);
        const list: any = await rest.find("patients", { $match: { name: { $in: ["A", "B"] } } });
        // read = ciphertext, decrypted manually
        for (const d of list) expect(d.ssn).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it("rejects operators that cannot work on ciphertext ($inc on an encrypted field)", async () => {
        const doc: any = await rest.findOne("patients", (await rest.find("patients", { $match: { name: "John" } }))[0]!._id);
        await expect(
            rest.updateOne("patients", doc._id, { $set: { ssn: "x" }, $inc: { age: 1 } }) // $inc on age (not encrypted) OK
        ).resolves.toBeTruthy();
        await expect(
            rest.updateOne("patients", doc._id, { $set: { ssn: "y" }, $inc: { ssn: 1 } as any }) // $inc on an encrypted field → rejected
        ).rejects.toThrow(/ENCRYPTED_FIELD_OPERATOR|not supported/);
    });

    it("throws ENCRYPTION_NOT_CONFIGURED when server.encryption is missing", async () => {
        delete (cfg.server as any).encryption;
        formatConfig({ server: { port: 4000 }, tenants: [] });
        await expect(rest.insertOne("patients", { name: "NoCfg", ssn: "000-00-0000" }))
            .rejects.toThrow(/ENCRYPTION_NOT_CONFIGURED|server\.encryption/);

        // restore the config for the following tests
        formatConfig({ server: { port: 4000, encryption: { mode: "symmetric", secret: "field-enc-secret" } }, tenants: [] });
    });
});

describe("field-level encryption — encryptionOptions.path (json sub-paths)", () => {
    it("encrypts only the configured sub-path of a json field", async () => {
        const doc: any = await rest.insertOne("patients", {
            name: "Alice",
            address: { street: "Rue X", city: "Paris", zip: "75000" },
        });
        // response = plaintext everywhere
        expect(doc.address.zip).toBe("75000");
        expect(doc.address.city).toBe("Paris");

        // in Mongo: only zip is ciphertext, the rest stays in clear
        const raw = await rest.db.collection("patients").findOne({ _id: new ObjectId(doc._id) });
        expect(raw!.address.zip).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(raw!.address.city).toBe("Paris");
        expect(raw!.address.street).toBe("Rue X");

        // rest read = ciphertext at the path, plaintext elsewhere
        const list: any = await rest.find("patients", { $match: { name: "Alice" } });
        expect(list[0].address.zip).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(list[0].address.city).toBe("Paris");

        // manual decryption
        const cipher = resolve();
        const zip = await cipher.decrypt<string>(list[0].address.zip, true);
        expect(zip).toBe("75000");
    });

    it("supports multiple paths and array-of-json", async () => {
        const doc: any = await rest.insertOne("patients", {
            name: "Bob",
            contacts: { phone: "0600000000", email: "bob@x.io", note: "public" },
            addresses: [{ zip: "69001" }, { zip: "69002", city: "Lyon" }],
        });
        const raw = await rest.db.collection("patients").findOne({ _id: new ObjectId(doc._id) });
        // array of json: every element encrypted on its zip
        expect(raw!.addresses[0].zip).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(raw!.addresses[1].zip).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(raw!.addresses[1].city).toBe("Lyon"); // non-encrypted value untouched
        // multiple paths
        expect(raw!.contacts.phone).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(raw!.contacts.email).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(raw!.contacts.note).toBe("public");
    });

    it("encrypts the path on $set replacement and dot-notation $set", async () => {
        const doc: any = await rest.findOne("patients", (await rest.find("patients", { $match: { name: "Alice" } }))[0]!._id);

        // $set of the whole json → zip re-encrypted inside the replacement
        const up1: any = await rest.updateOne("patients", doc._id, { $set: { address: { city: "Nice", zip: "06000" } } });
        expect(up1.address.zip).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(up1.address.city).toBe("Nice");

        // dot-notation $set on the exact path → value encrypted
        const up2: any = await rest.updateOne("patients", doc._id, { $set: { "address.zip": "06100" } });
        expect(up2.address.zip).toMatch(/^[A-Za-z0-9+/=]+$/);
        const raw = await rest.db.collection("patients").findOne({ _id: new ObjectId(doc._id) });
        const cipher = resolve();
        expect(await cipher.decrypt<string>(raw!.address.zip, true)).toBe("06100");
    });

    it("rejects $inc on an encrypted sub-path", async () => {
        const doc: any = await rest.findOne("patients", (await rest.find("patients", { $match: { name: "Bob" } }))[0]!._id);
        await expect(
            rest.updateOne("patients", doc._id, { $inc: { "addresses.0.zip": 1 } as any })
        ).rejects.toThrow(/ENCRYPTED_FIELD_OPERATOR|not supported/);
    });
});
