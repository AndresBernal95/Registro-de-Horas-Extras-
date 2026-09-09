/* Hook de resolución: cualquier import de @neondatabase/serverless
   apunta al puente de pruebas. */
import { pathToFileURL } from 'node:url';
const DESTINO = pathToFileURL(new URL('./pg-shim.mjs', import.meta.url).pathname).href;

export function resolve(especificador, contexto, siguiente) {
  if (especificador === '@neondatabase/serverless') {
    return { url: DESTINO, shortCircuit: true };
  }
  return siguiente(especificador, contexto);
}
