import { cleanDeep, clone, deepCopy, omit, pick, jwt, isSlug } from './func';
const jose = jwt
const utils = {
    password: Bun.password,
    $: Bun.$,
    secrets: Bun.secrets,
    deepEquals: Bun.deepEquals,
    cleanDeep,
    clone,
    deepCopy,
    omit,
    pick,
    jose,
    isSlug,
}


export default utils;
