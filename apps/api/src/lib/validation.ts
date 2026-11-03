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

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('E-mail inválido.')
  .max(254);

export const uuidSchema = z.string().uuid('Identificador inválido.');
