import { Request, Response, NextFunction } from "express";
import { sendError } from "../utils/helpers";

export function notFoundHandler(
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  sendError(
    res,
    `接口不存在: ${req.method} ${req.originalUrl}`,
    undefined,
    404,
  );
}

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error("[Server Error]", err);
  const statusCode = err.statusCode || err.code === "SQLITE_ERROR" ? 400 : 500;
  const message = err.message || "服务器内部错误";
  sendError(res, message, err.details || undefined, statusCode);
}
