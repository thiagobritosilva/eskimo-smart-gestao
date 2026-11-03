/**
 * Cria o primeiro usuário Proprietário.
 *   npm run create-owner -- --name "Fulano" --email fulano@loja.com.br
 * A senha é solicitada no terminal (sem eco) ou lida de OWNER_PASSWORD.
 * Só funciona enquanto não existir nenhum Proprietário ativo (evita uso indevido).
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { migrate } from '../db/migrate.js';
import { closePool, getPool, withTransaction } from '../db/pool.js';
import { writeAudit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { emailSchema, passwordSchema } from '../lib/validation.js';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
    out._writeToOutput = (s: string) => {
      if (s.includes(question)) out.output.write(s);
      else out.output.write('*');
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const { values } = parseArgs({ options: { name: { type: 'string' }, email: { type: 'string' } } });

try {
  if (!values.name || !values.email) throw new Error('Uso: npm run create-owner -- --name "Nome" --email email@dominio');
  const email = emailSchema.parse(values.email);
  const pool = getPool();
  await migrate(pool);

  const owners = await pool.query(
    `SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'PROPRIETARIO' AND u.is_active`,
  );
  if (owners.rowCount) throw new Error('Já existe Proprietário ativo. Novos usuários devem ser criados pelo sistema.');

  let password = process.env.OWNER_PASSWORD;
  if (!password) {
    password = await askHidden('Senha do Proprietário (mín. 10 caracteres, letras e números): ');
    const confirm = await askHidden('Confirme a senha: ');
    if (password !== confirm) throw new Error('As senhas não conferem.');
  }
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);

  const hash = await hashPassword(password);
  const id = await withTransaction(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash, role_id, must_change_password)
       SELECT $1, $2, $3, id, false FROM roles WHERE code = 'PROPRIETARIO' RETURNING id`,
      [values.name!.trim(), email, hash],
    );
    await writeAudit(db, { actorType: 'system' }, {
      action: 'user.owner_bootstrap',
      entity: 'user',
      entityId: rows[0]!.id,
      after: { name: values.name, email },
    });
    return rows[0]!.id;
  });
  console.log(`✔ Proprietário criado (id ${id}). Acesse o sistema com ${email}.`);
} catch (err) {
  console.error('✖', (err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
