import pg from 'pg';
export const neonConfig = {};
const pool = new pg.Pool({ host:'/tmp', port:5433, user:'postgres', database:'gpa', max:5 });
globalThis.__SQL_LOG = globalThis.__SQL_LOG || [];
export function neon(){
  return async function(strings, ...vals){
    if(typeof strings === 'string'){
      const r = await pool.query(strings, vals[0]||[]);
      return r.rows;
    }
    let q=''; strings.forEach((s,i)=>{ q += s + (i<vals.length ? '$'+(i+1) : ''); });
    globalThis.__SQL_LOG.push(q.replace(/\s+/g,' ').trim().slice(0,160));
    const r = await pool.query(q, vals);
    return r.rows;
  };
}
