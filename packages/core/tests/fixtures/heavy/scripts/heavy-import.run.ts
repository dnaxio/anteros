export default {
    _isScript_: true,
    enabled: true,
    heavy: true,
    exec: async ({ rest, progress }: any) => {
        const items = Array.from({ length: 10 }, (_, i) => ({ name: `item-${i}` }));
        await rest.insertMany('items', items);
        progress?.(50, { inserted: 10 });

        await rest.insertMany('items', items.map((it) => ({ ...it, name: it.name + '-b' })));
        progress?.(100, { inserted: 20 });
        return { ok: true, total: 20 };
    },
};
