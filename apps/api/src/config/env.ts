import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Origem pública do front-end (usada na verificação de Origin/CSRF). */
  APP_ORIGIN: z.string().url(),
  /** Chave AES-256 em base64 (32 bytes) para cifrar credenciais de integração. */
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENCRYPTION_KEY deve ter 32 bytes em base64'),
  /** Tentativas de login por IP por minuto. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  SESSION_COOKIE_NAME: z.string().default('esg_session'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Diretório do build do front-end, servido pela API em produção. */
  WEB_DIST_DIR: z.string().optional(),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Configuração inválida nas variáveis de ambiente:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
