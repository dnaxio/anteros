import type { ServerConfig, Config } from "../types/config"
import path from "path"
import pkg from '../package.json';
import { cleanDeep } from "../utils/func";
const cfg: Config = { // app Config

    server: {
        port: 4000,
    },
    tenants: []
}




function formatConfig(config: ServerConfig) { // format the config

    cfg.server = {
        ...cfg.server,
        ...config.server,
    }
    cfg.version = config.version;
    cfg.tenants = config.tenants ?? [];
    return cfg;
}

async function loadAppConfig(serverConfig: ServerConfig) {
    try {
        /* const PKG =
            await import(path.resolve(process.cwd(), 'package.json')); */
        formatConfig({
            ...serverConfig,
            version: pkg.version,
        });
    } catch (err: any) {
        console.error('Error loading app config', err?.message);
    }
}



function safePublicConfig() {
    return cleanDeep({
        tenants: (cfg.tenants ?? []).map(t => ({
            id: t.id,
            name: t.name ?? t.id,
        })),
        collections: (cfg.collections ?? []).map(c => ({
            _tenant_: c._tenant_,
            slug: c.slug,
            type: c.type,
            actions: [
                'insertOne', 'insertMany', 'updateOne', 'updateMany',
                'deleteOne', 'deleteMany', 'findOne', 'find',
                'aggregate',
                ...Object.keys(c.actions ?? {}),
            ],
            fields: (c.fields ?? []).map(f => ({
                name: f.name,
                type: f.type,
                description: f.description,
                required: f.required,
                nullable: f.nullable,
                empty: f.empty,
                relation: f.relation,
                enumOptions: f.enumOptions,
                randomOptions: f.randomOptions,
                defaultValue: f.defaultValue,
                studio: f.studio,
            })),
            readOnlyFields: c.api?.readOnlyFields,
            studio: c.studio,
        })),
        services: (cfg.services ?? []).map(s => ({
            _tenant_: s._tenant_,
            name: s.name,
            enabled: s.enabled,
            actions: Object.keys(s.actions ?? {}),
        })),
        fileCollections: (cfg.fileCollections ?? []).map(fc => ({
            _tenant_: fc._tenant_,
            slug: fc.slug,
            fields: (fc.fields ?? []).map(f => ({
                name: f.name,
                type: f.type,
                description: f.description,
                required: f.required,
                nullable: f.nullable,
                empty: f.empty,
                relation: f.relation,
                enumOptions: f.enumOptions,
                randomOptions: f.randomOptions,
                defaultValue: f.defaultValue,
                studio: f.studio,
            })),
            readOnlyFields: fc.api?.readOnlyFields,
        })),
    })
}

export {
    formatConfig,
    cfg,
    loadAppConfig,
    safePublicConfig
}
