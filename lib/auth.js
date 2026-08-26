import bcrypt from 'bcryptjs';

/* ══════════════════════════════════════════════════════════════════
   CONTRASEÑAS — cifrado transparente, sin migración manual

   Problema original: las contraseñas estaban en texto plano en la
   tabla usuarios. Cualquiera con acceso a Neon las veía todas.

   Solución sin riesgo de romper el acceso de nadie:
   · Si el valor guardado ya es un hash bcrypt → se compara con bcrypt.
   · Si sigue en texto plano → se compara directo Y, si la contraseña
     es correcta, se re-guarda cifrada en ese mismo instante.
   Resultado: nadie tiene que cambiar su contraseña, no hay script de
   migración que ejecutar, y la base se va cifrando sola conforme la
   gente entra. Al terminar la primera ronda de accesos ya no queda
   ninguna en texto plano.

   Costo: bcrypt con 10 rondas tarda ~60-90 ms y SÓLO corre en el
   login (una vez por sesión). No afecta la velocidad de la app.
   ══════════════════════════════════════════════════════════════════ */

const RONDAS = 10;

export function esHash(v) {
  return typeof v === 'string' && /^\$2[aby]?\$\d{2}\$/.test(v);
}

export function hashPassword(plano) {
  return bcrypt.hashSync(String(plano), RONDAS);
}

/** Devuelve { valido, necesitaCifrado } */
export function verificarPassword(plano, guardado) {
  if (guardado == null) return { valido: false, necesitaCifrado: false };
  const p = String(plano);
  if (esHash(guardado)) {
    let ok = false;
    try { ok = bcrypt.compareSync(p, guardado); } catch { ok = false; }
    return { valido: ok, necesitaCifrado: false };
  }
  // Texto plano heredado
  const ok = p === String(guardado);
  return { valido: ok, necesitaCifrado: ok };
}

/** Guarda una contraseña nueva ya cifrada (usado al crear/editar usuarios). */
export function prepararPassword(plano) {
  if (plano == null || plano === '') return null;
  return esHash(plano) ? String(plano) : hashPassword(plano);
}

/* ── Reglas de visibilidad por rol ──────────────────────────────── */
export function puedeVerMonitor(rol) {
  return rol === 'jefe' || rol === 'gerente' || rol === 'admin';
}
export function puedeAdministrarUsuarios(rol) {
  return rol === 'admin';
}
