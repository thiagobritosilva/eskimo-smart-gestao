import { z, type ZodTypeAny } from 'zod';
import { Errors } from './errors.js';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw Errors.badRequest(
      'Dados inválidos.',
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export const passwordSchema = z
  .string()
  .min(10, 'A senha deve ter pelo menos 10 caracteres.')
  .max(128, 'A senha deve ter no máximo 128 caracteres.')
  .refine((v) => /[A-Za-zÀ-ÿ]/.test(v) && /\d/.test(v), 'A senha deve conter letras e números.');

/**
 * Senha PROVISÓRIA (definida pelo gestor ao criar/redefinir o usuário): a partir de 4 caracteres (ex.: 4 números).
 * O usuário é obrigado a trocá-la no primeiro acesso por uma senha definitiva (signupPasswordSchema).
 */
export const temporaryPasswordSchema = z
  .string()
  .min(4, 'A senha provisória deve ter pelo menos 4 caracteres (ex.: 4 números).')
  .max(128, 'A senha deve ter no máximo 128 caracteres.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('E-mail inválido.')
  .max(254);

export const uuidSchema = z.string().uuid('Identificador inválido.');

/** Decimal não negativo como string (aceita número ou texto com ponto). */
export const decimalSchema = (maxDecimals: number, message = 'Valor numérico inválido.') =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => new RegExp(`^\\d{1,11}(\\.\\d{1,${maxDecimals}})?$`).test(v), message);

export const optionalDecimal = (maxDecimals: number) =>
  z.union([decimalSchema(maxDecimals), z.null(), z.literal('').transform(() => null)]).optional();

/** Senha escolhida pelo próprio usuário (cadastro por link e troca de senha): a partir de 4 caracteres, sem exigência de tipos. */
export const signupPasswordSchema = z
  .string()
  .min(4, 'A senha deve ter pelo menos 4 caracteres.')
  .max(128, 'A senha deve ter no máximo 128 caracteres.');
