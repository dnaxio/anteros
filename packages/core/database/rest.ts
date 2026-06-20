import type { RestOptions } from "../types/rest";
import { MongoRest } from "./mongodbadapter";

class Rest extends MongoRest {
    constructor(options: RestOptions) {
        super(options);
    }
}

const useRest = Rest

export {
    useRest,
}
