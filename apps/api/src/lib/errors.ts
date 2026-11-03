export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details),
  unauthorized: (message = 'Autenticação necessária.') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Você não tem permissão para esta operação.') => new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Registro não encontrado.') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message: string) => new AppError(409, 'CONFLICT', message),
  locked: (message: string) => new AppError(423, 'LOCKED', message),
  businessRule: (message: string) => new AppError(422, 'BUSINESS_RULE', message),
};
