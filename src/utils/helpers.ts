import { v4 as uuidv4 } from "uuid";
import db from "../db/database";
import { Request, Response, NextFunction } from "express";
import { ApiResponse, PaginationParams, PaginationResult } from "../types";

export function generateId(): string {
  return uuidv4();
}

export function sendResponse<T>(
  res: Response,
  success: boolean,
  message: string,
  data?: T,
  statusCode: number = 200,
): void {
  const response: ApiResponse<T> = { success, message, data };
  res.status(statusCode).json(response);
}

export function sendError(
  res: Response,
  message: string,
  errors?: string[],
  statusCode: number = 400,
): void {
  const response: ApiResponse = { success: false, message, errors };
  res.status(statusCode).json(response);
}

export function handleAsync(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function getPaginationParams(query: any): {
  page: number;
  pageSize: number;
  offset: number;
} {
  const page = Math.max(1, parseInt(query.page as string) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(query.pageSize as string) || 20),
  );
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

export function buildPaginationResult<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PaginationResult<T> {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  };
}

export function checkRoomScheduleConflict(
  roomId: string,
  schedules: { date: string; start_time: string; end_time: string }[],
  excludeClassId?: string,
): { conflict: boolean; message: string } {
  for (const sched of schedules) {
    let query = `
      SELECT cs.id, tc.name as class_name
      FROM class_schedules cs
      JOIN training_classes tc ON cs.class_id = tc.id
      WHERE cs.date = ? AND cs.class_id != ?
        AND NOT (cs.end_time <= ? OR cs.start_time >= ?)
        AND tc.room_id = ?
    `;
    const params: any[] = [
      sched.date,
      excludeClassId || "",
      sched.start_time,
      sched.end_time,
      roomId,
    ];
    const conflicts: any = db.prepare(query).get(...params);
    if (conflicts) {
      return {
        conflict: true,
        message: `培训室在 ${sched.date} ${sched.start_time}-${sched.end_time} 已被班级"${conflicts.class_name}"占用`,
      };
    }
  }
  return { conflict: false, message: "" };
}

export const MIN_REQUIRED_ATTENDANCE_RATE = 80;

export function getScheduleCount(classId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM class_schedules WHERE class_id = ?`,
      )
      .get(classId) as any
  ).count;
}

export function calcAttendanceRate(
  classId: string,
  housekeeperId: string,
): number {
  const rows = db
    .prepare(
      `
    SELECT status FROM attendances
    WHERE class_id = ? AND housekeeper_id = ?
  `,
    )
    .all(classId, housekeeperId) as any[];
  if (rows.length === 0) return 0;
  const valid = rows.filter(
    (r) => r.status === "present" || r.status === "leave",
  ).length;
  return Math.round((valid / rows.length) * 10000) / 100;
}

export function hasSufficientAttendance(
  classId: string,
  housekeeperId: string,
): boolean {
  const scheduleCount = getScheduleCount(classId);
  if (scheduleCount === 0) return false;

  const attendanceRows = db
    .prepare(
      `SELECT status FROM attendances WHERE class_id = ? AND housekeeper_id = ?`,
    )
    .all(classId, housekeeperId) as any[];

  if (attendanceRows.length < scheduleCount) return false;

  const validAttendance = attendanceRows.filter(
    (r) => r.status === "present" || r.status === "leave",
  ).length;
  const rate = (validAttendance / scheduleCount) * 100;
  return rate >= MIN_REQUIRED_ATTENDANCE_RATE;
}
