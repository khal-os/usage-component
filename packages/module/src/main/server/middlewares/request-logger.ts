import { NextFunction, Request, Response } from 'express';
import { Logger } from '@observability/core/common/logging/logger.js';

export const makeRequestLoggerMiddleware = (logger: Logger) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Docs serve as the container healthcheck and /health is the probe
    // path (decision 172) — logging either would print a line every 15s
    // per instance.
    if (req.path.startsWith('/api/v1/docs') || req.path === '/health') {
      next();
      return;
    }

    const startedAt = Date.now();

    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  };
};
