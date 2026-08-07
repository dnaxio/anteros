import { Cache } from "./utils/cache";

async function probe() {
    const c = new Cache("memory");
    const v = await c.get({ key: "k" });
    const p = await c.pull({ key: "p" });
    const g = await c.getOrSet({ key: "g", factory: () => 42 });
    const s = await c.set({ key: "a", value: 1 });
    const h = await c.has({ key: "a" });
    const i: unknown = v;
    const j: unknown = p;
    const k: unknown = g;
    console.log(typeof v, typeof p, typeof g, s, h);
    void i; void j; void k;
}
void probe;
