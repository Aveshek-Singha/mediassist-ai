import type { User } from '../modules/models.js';

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      user?: User;
      rawBody?: string;
      publicApiKey?: string;
    }
  }
}

export {};
