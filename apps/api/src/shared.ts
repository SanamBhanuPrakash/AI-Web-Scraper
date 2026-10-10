/**
 * The API's one doorway to the shared wire types and schemas.
 *
 * It is a relative import on purpose. `@digest/shared` is a workspace package whose entry is TypeScript source, and
 * Node cannot load TypeScript from inside `node_modules`, which is where a serverless build puts a workspace link.
 * A relative path is compiled together with the rest of the function and always resolves.
 */
export * from '../../../packages/shared/src/index.js';
