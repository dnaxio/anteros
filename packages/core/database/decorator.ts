import { ObjectId } from "mongodb";
import { getCollection } from "./collection";
import { AppError } from "../lib/error";
import { logger } from "../utils/logger";
import { cfg } from "../server/config";


// Logs operations slower than cfg.server.logging.slowQueryMs (default 200ms) —
// the MongoDB-style slow query log for Anteros

export function LogSlowQuery(): any {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): any {
        if (!descriptor || !descriptor.value) {
            return descriptor;
        }
        const originalMethod = descriptor.value;
        descriptor.value = async function (this: any, ...args: any[]) {
            const start = performance.now();
            try {
                return await originalMethod.apply(this, args);
            } finally {
                const duration = performance.now() - start;
                const slowMs = cfg.server.logging?.slowQueryMs ?? 200;
                if (duration >= slowMs) {
                    logger.warn(`Slow ${propertyKey} (${Math.round(duration)}ms)`, {
                        collection: args[0],
                        tenant: this.tenant_id,
                        duration: Math.round(duration),
                    });
                }
            }
        };
        return descriptor;
    }
}


// decoration function checkCollectionExists
export function CheckIfCollectionExists(): any {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): any {
        if (!descriptor || !descriptor.value) {
            return descriptor;
        }
        const originalMethod = descriptor.value;
        descriptor.value = async function (this: any, ...args: any[]) {
            let collection = args[0];
            let col = getCollection(collection, this.tenant_id)
            if (!col) {
                throw new AppError(`collection '${collection}' not found`, {
                    code: 'COLLECTION_NOT_FOUND',
                    status: 500
                })
            }
            return await originalMethod.apply(this, args);
        };
        return descriptor;
    }
}



export function CheckIfArrayOfIds(action: string): any {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): any {
        if (!descriptor || !descriptor.value) {
            return descriptor;
        }
        const originalMethod = descriptor.value;
        descriptor.value = async function (...args: any[]) {
            let collection = args[0];
            let _ids = args[1];
            if (!Array.isArray(_ids)) {
                throw new AppError(`[${collection}] [${action}] IDs must be an array`, {
                    code: 'INVALID_ARGUMENT',
                    status: 400
                })
            }
            for (let id of _ids) {
                if (!ObjectId.isValid(id)) {
                    throw new AppError(`[${collection}] [${action}] IDs must be an array of valid ObjectId`, {
                        code: 'INVALID_ARGUMENT',
                        status: 400
                    })
                }
            }
            if (_ids.length === 0) {
                throw new AppError(`[${collection}] [${action}] IDs must be an array of at least one valid ObjectId`, {
                    code: 'INVALID_ARGUMENT',
                    status: 400
                })
            }
            return await originalMethod.apply(this, args);
        }
        return descriptor;
    };
}

export function CheckInsertData(action: string): any {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): any {
        if (!descriptor || !descriptor.value) {
            return descriptor;
        }
        const originalMethod = descriptor.value;
        descriptor.value = async function (...args: any[]) {
            let collection = args[0];
            let data = args[1];
            if (action === 'insertOne') {
                if (!data) throw new AppError(`[${collection}] [${action}] Data is required`, {
                    code: 'INVALID_ARGUMENT',
                    status: 400
                })
            }
            if (action === 'insertMany') {
                if (!data) throw new AppError(`[${collection}] [${action}] Data is required`, {
                    code: 'INVALID_ARGUMENT',
                    status: 400
                })
            }
            return await originalMethod.apply(this, args);
        }
    }
}

export function CheckIfId(action: string): any {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): any {
        if (!descriptor || !descriptor.value) {
            return descriptor;
        }
        const originalMethod = descriptor.value;
        descriptor.value = async function (...args: any[]) {
            let collection = args[0];
            let _id = args[1];
            if (!ObjectId.isValid(_id)) {
                throw new AppError(`[${collection}] [${action}] ID must be a valid ObjectId`, {
                    code: 'INVALID_ARGUMENT',
                    status: 400
                })
            }
            return await originalMethod.apply(this, args);
        }
        return descriptor;
    }
}


export function CheckFilter(): any {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): any {
        if (!descriptor || !descriptor.value) {
            return descriptor;
        }
        const originalMethod = descriptor.value;
        descriptor.value = async function (...args: any[]) {
            let collection = args[0];
            let filter = args[1];
            if (
                filter === null ||
                filter === undefined ||
                (typeof filter === 'object' && Object.keys(filter).length === 0)
            ) {
                throw new AppError(`[${collection}] [${propertyKey}] Filter is required and must not be empty`, {
                    code: 'FILTER_REQUIRED',
                    status: 400
                })
            }
            return await originalMethod.apply(this, args);
        }
        return descriptor;
    }
}

export function CheckBulkWriteOperations(): any {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): any {
        if (!descriptor || !descriptor.value) {
            return descriptor;
        }
        const originalMethod = descriptor.value;
        descriptor.value = async function (...args: any[]) {
            let collection = args[0];
            let operations = args[1];
            for (let operation of operations) {
                if (!operation) throw new AppError(`[${collection}] [bulkWrite] Operation is required`, {
                    code: 'INVALID_ARGUMENT',
                    status: 400
                })
                if (Object.hasOwn(operation, 'insertOne')) {
                    if (!operation.insertOne.document) throw new AppError(`[${collection}] [bulkWrite] Document is required`, {
                        code: 'INVALID_ARGUMENT',
                        status: 400
                    })
                }
                if (Object.hasOwn(operation, 'updateOne')) {
                    if (!operation.updateOne.filter) throw new AppError(`[${collection}] [bulkWrite] Filter is required`, {
                        code: 'INVALID_ARGUMENT',
                        status: 400
                    })
                }
                if (Object.hasOwn(operation, 'updateMany')) {
                    if (!operation.updateMany.filter) throw new AppError(`[${collection}] [bulkWrite] Filter is required`, {
                        code: 'INVALID_ARGUMENT',
                        status: 400
                    })
                }
            }
            return await originalMethod.apply(this, args);
        }
        return descriptor;
    }
}

