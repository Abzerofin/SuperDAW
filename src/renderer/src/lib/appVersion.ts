/**
 * The running app version, injected from package.json at build time (see
 * the `define` in the vite configs). Never read from disk: the renderer has
 * to work in a plain browser too.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
