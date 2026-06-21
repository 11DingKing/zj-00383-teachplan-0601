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
  const scheduleCount = getScheduleCount(classId);
  if (scheduleCount === 0) return 0;

  const attendanceRows = db
    .prepare(
      `SELECT schedule_id, status, is_makeup, original_schedule_id FROM attendances WHERE class_id = ? AND housekeeper_id = ?`,
    )
    .all(classId, housekeeperId) as any[];

  const originalAttendance = new Map<string, string>();
  const makeupCovered = new Set<string>();

  for (const row of attendanceRows) {
    if (row.is_makeup === 1 && row.original_schedule_id) {
      if (row.status === "present" || row.status === "leave") {
        makeupCovered.add(row.original_schedule_id);
      }
    } else {
      originalAttendance.set(row.schedule_id, row.status);
    }
  }

  let validCount = 0;
  const schedules = db
    .prepare(`SELECT id FROM class_schedules WHERE class_id = ?`)
    .all(classId) as any[];

  for (const sched of schedules) {
    const schedId = sched.id;
    const status = originalAttendance.get(schedId);
    if (
      (status && (status === "present" || status === "leave")) ||
      makeupCovered.has(schedId)
    ) {
      validCount++;
    }
  }

  return Math.round((validCount / scheduleCount) * 10000) / 100;
}

export function hasSufficientAttendance(
  classId: string,
  housekeeperId: string,
): boolean {
  const rate = calcAttendanceRate(classId, housekeeperId);
  return rate >= MIN_REQUIRED_ATTENDANCE_RATE;
}

export function getMakeupCount(classId: string, housekeeperId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM attendances WHERE class_id = ? AND housekeeper_id = ? AND is_makeup = 1 AND status IN ('present', 'leave')`,
      )
      .get(classId, housekeeperId) as any
  ).count;
}

export function hasMakeup(classId: string, housekeeperId: string): boolean {
  return getMakeupCount(classId, housekeeperId) > 0;
}

export function getRetakeCount(classId: string, housekeeperId: string): number {
  const exam = db
    .prepare(
      `SELECT retake_count FROM graduation_exams WHERE class_id = ? AND housekeeper_id = ?`,
    )
    .get(classId, housekeeperId) as any;
  return exam ? exam.retake_count || 0 : 0;
}

export function hasRetake(classId: string, housekeeperId: string): boolean {
  return getRetakeCount(classId, housekeeperId) > 0;
}

export function isWaitingPromoted(
  classId: string,
  housekeeperId: string,
): boolean {
  const reg = db
    .prepare(
      `SELECT promoted_at FROM registrations WHERE class_id = ? AND housekeeper_id = ? AND status = 'enrolled'`,
    )
    .get(classId, housekeeperId) as any;
  return !!(reg && reg.promoted_at);
}

export function getFinalExamResult(
  classId: string,
  housekeeperId: string,
): { result: string; score: number; certificate_no?: string } | null {
  const exam = db
    .prepare(
      `SELECT result, score, certificate_no FROM graduation_exams WHERE class_id = ? AND housekeeper_id = ?`,
    )
    .get(classId, housekeeperId) as any;
  if (!exam) return null;
  return {
    result: exam.result,
    score: exam.score,
    certificate_no: exam.certificate_no || undefined,
  };
}

export function getAbsentList(classId: string): any[] {
  const schedules = db
    .prepare(
      `SELECT id, date, content FROM class_schedules WHERE class_id = ? ORDER BY date, start_time`,
    )
    .all(classId) as any[];

  const enrolled = db
    .prepare(
      `SELECT r.housekeeper_id, h.name, h.phone
       FROM registrations r
       JOIN housekeepers h ON r.housekeeper_id = h.id
       WHERE r.class_id = ? AND r.status = 'enrolled'`,
    )
    .all(classId) as any[];

  const result: any[] = [];
  for (const sched of schedules) {
    for (const hk of enrolled) {
      const att = db
        .prepare(
          `SELECT status, is_makeup, makeup_schedule_id FROM attendances
           WHERE (schedule_id = ? OR (original_schedule_id = ? AND is_makeup = 1))
           AND housekeeper_id = ?`,
        )
        .all(sched.id, sched.id, hk.housekeeper_id) as any[];

      let isAbsent = true;
      for (const a of att) {
        if (a.status === "present" || a.status === "leave") {
          isAbsent = false;
          break;
        }
      }

      const makeupScheduled = db
        .prepare(
          `SELECT mr.*, ms.date, ms.start_time, ms.end_time, ms.content as makeup_content
           FROM makeup_registrations mr
           JOIN makeup_schedules ms ON mr.makeup_schedule_id = ms.id
           WHERE mr.original_schedule_id = ? AND mr.housekeeper_id = ? AND mr.status != 'cancelled'`,
        )
        .get(sched.id, hk.housekeeper_id);

      if (isAbsent) {
        result.push({
          schedule_id: sched.id,
          schedule_date: sched.date,
          schedule_content: sched.content,
          housekeeper_id: hk.housekeeper_id,
          housekeeper_name: hk.name,
          housekeeper_phone: hk.phone,
          makeup_scheduled: !!makeupScheduled,
          makeup_info: makeupScheduled || null,
        });
      }
    }
  }
  return result;
}
