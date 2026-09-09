/* Registra el cargador que sustituye @neondatabase/serverless por el
   puente a PostgreSQL local (test/pg-shim.mjs). Ver ese archivo. */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./cargador-shim.mjs', pathToFileURL(import.meta.filename));
