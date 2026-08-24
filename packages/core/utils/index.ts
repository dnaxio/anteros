import { cleanDeep, clone, deepCopy, omit, pick, jwt, isSlug } from './func';
import { useSymCrypt, useAsymCrypt, resolve } from './crypto';
const jose = jwt
const utils = {
    password: Bun.password,
    $: Bun.$,
    secrets: Bun.secrets,
    deepEquals: Bun.deepEquals,
    cron:Bun.cron,
    cleanDeep,
    clone,
    deepCopy,
    omit,
    pick,
    jose,
    isSlug,
    sleep:Bun.sleep,
    // Encryption — AES-256-GCM sym + RSA-OAEP asym (never shadow the Web Crypto global)
    crypt: { useSymCrypt, useAsymCrypt, resolve },
}


export default utils;
