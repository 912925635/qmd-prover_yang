import { readFile } from 'node:fs/promises';
import { exists, relativePosix, sha256 } from './files.js';
import { auxLayout } from './auxiliary.js';
export function externalPolicyHash(policy) {
    return sha256(JSON.stringify(policy));
}
export async function readExternalPolicy(root) {
    const file = auxLayout(root).external;
    if (!await exists(file))
        return { path: relativePosix(root, file), mode: 'unrestricted', content: null };
    const content = await readFile(file, 'utf8');
    return { path: relativePosix(root, file), mode: content.trim() ? 'declared' : 'none', content };
}
