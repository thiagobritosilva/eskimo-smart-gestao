import pg from 'pg';

/** Recria o schema do banco de TESTE do zero (nunca aponte para produção). */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://eskimo:eskimo_dev@localhost:5432/eskimo_test';
  if (!/test/.test(new URL(url).pathname)) throw new Error('Banco de teste deve conter "test" no nome.');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
}
