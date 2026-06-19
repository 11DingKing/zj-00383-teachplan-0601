import { Router, Request, Response } from "express";
import db from "../db/database";
import {
  generateId,
  sendResponse,
  sendError,
  handleAsync,
} from "../utils/helpers";
import { Attendance, AttendanceStatus } from "../types";

const router = Router();

router.post(
  "/batch",
  handleAsync(async (req: Request, res: Response) => {
    const { schedule_id, records } = req.body;
    if (!schedule_id || !Array.isArray(records) || records.length === 0) {
      return sendError(res, "请提供 schedule_id 和考勤记录数组");
    }

    const schedule = db
      .prepare(
        `
    SELECT cs.*, tc.status as class_status, tc.id as class_id
    FROM class_schedules cs
    JOIN training_classes tc ON cs.class_id = tc.id
    WHERE cs.id = ?
  `,
      )
      .get(schedule_id) as any;
    if (!schedule) return sendError(res, "课程安排不存在", undefined, 404);
    if (!["started", "in_training"].includes(schedule.class_status)) {
      return sendError(res, "只有已开班或培训中的班级可以记录考勤");
    }

    const tx = db.transaction(() => {
      const upsert = db.prepare(`
      INSERT INTO attendances (id, class_id, schedule_id, housekeeper_id, status, remark)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(schedule_id, housekeeper_id) DO UPDATE SET
        status = excluded.status,
        remark = excluded.remark,
        recorded_at = datetime('now')
    `);
      for (const rec of records) {
        const validStatus = ["present", "absent", "leave"].includes(rec.status)
          ? rec.status
          : "present";
        upsert.run(
          generateId(),
          schedule.class_id,
          schedule_id,
          rec.housekeeper_id,
          validStatus,
          rec.remark || "",
        );
      }
    });

    try {
      tx();
      const saved = db
        .prepare(
          `
      SELECT a.*, h.name as housekeeper_name
      FROM attendances a
      LEFT JOIN housekeepers h ON a.housekeeper_id = h.id
      WHERE a.schedule_id = ?
      ORDER BY h.name ASC
    `,
        )
        .all(schedule_id);
      sendResponse(res, true, "考勤记录已保存", saved);
    } catch (err: any) {
      sendError(res, "保存失败: " + err.message);
    }
  }),
);

router.get(
  "/schedule/:scheduleId",
  handleAsync(async (req: Request, res: Response) => {
    const schedule = db
      .prepare(
        `
    SELECT cs.*, tc.id as class_id, tc.name as class_name,
           tc.status as class_status
    FROM class_schedules cs
    LEFT JOIN training_classes tc ON cs.class_id = tc.id
    WHERE cs.id = ?
  `,
      )
      .get(req.params.scheduleId);

    if (!schedule) return sendError(res, "课程安排不存在", undefined, 404);

    const attendances = db
      .prepare(
        `
    SELECT a.*, h.name as housekeeper_name, h.id_card as housekeeper_id_card
    FROM attendances a
    LEFT JOIN housekeepers h ON a.housekeeper_id = h.id
    WHERE a.schedule_id = ?
    ORDER BY h.name ASC
  `,
      )
      .all(req.params.scheduleId);

    const enrolled = db
      .prepare(
        `
    SELECT DISTINCT r.housekeeper_id, h.name as housekeeper_name, h.id_card as housekeeper_id_card
    FROM registrations r
    LEFT JOIN housekeepers h ON r.housekeeper_id = h.id
    WHERE r.class_id = (SELECT class_id FROM class_schedules WHERE id = ?)
      AND r.status = 'enrolled'
    ORDER BY h.name ASC
  `,
      )
      .all(req.params.scheduleId);

    const byId = new Map<string, any>(
      attendances.map((a: any) => [a.housekeeper_id, a]),
    );
    const combined = enrolled.map((e: any) => {
      const att: any | undefined = byId.get(e.housekeeper_id);
      return {
        housekeeper_id: e.housekeeper_id,
        housekeeper_name: e.housekeeper_name,
        housekeeper_id_card: e.housekeeper_id_card,
        status: att ? att.status : null,
        remark: att ? att.remark : "",
        attendance_id: att ? att.id : null,
      };
    });

    sendResponse(res, true, "获取成功", {
      schedule,
      attendances: combined,
    });
  }),
);

router.get(
  "/class/:classId/housekeeper/:housekeeperId",
  handleAsync(async (req: Request, res: Response) => {
    const { classId, housekeeperId } = req.params;
    const rows = db
      .prepare(
        `
    SELECT a.*, cs.date, cs.start_time, cs.end_time, cs.content
    FROM attendances a
    LEFT JOIN class_schedules cs ON a.schedule_id = cs.id
    WHERE a.class_id = ? AND a.housekeeper_id = ?
    ORDER BY cs.date, cs.start_time
  `,
      )
      .all(classId, housekeeperId);

    const total = rows.length;
    const present = rows.filter((r: any) => r.status === "present").length;
    const leave = rows.filter((r: any) => r.status === "leave").length;
    const absent = rows.filter((r: any) => r.status === "absent").length;
    const attendanceRate =
      total > 0 ? Math.round(((present + leave) / total) * 10000) / 100 : 0;

    sendResponse(res, true, "获取成功", {
      records: rows,
      summary: {
        total,
        present,
        leave,
        absent,
        attendance_rate: attendanceRate,
      },
    });
  }),
);

router.get(
  "/class/:classId/summary",
  handleAsync(async (req: Request, res: Response) => {
    const { classId } = req.params;
    const enrolled = db
      .prepare(
        `
    SELECT r.housekeeper_id, h.name
    FROM registrations r
    LEFT JOIN housekeepers h ON r.housekeeper_id = h.id
    WHERE r.class_id = ? AND r.status = 'enrolled'
    ORDER BY h.name
  `,
      )
      .all(classId) as any[];

    const result = enrolled.map((hk) => {
      const rows = db
        .prepare(
          `
      SELECT a.status FROM attendances a
      WHERE a.class_id = ? AND a.housekeeper_id = ?
    `,
        )
        .all(classId, hk.housekeeper_id) as any[];
      const total = rows.length;
      const present = rows.filter((r) => r.status === "present").length;
      const leave = rows.filter((r) => r.status === "leave").length;
      const absent = rows.filter((r) => r.status === "absent").length;
      const attendanceRate =
        total > 0 ? Math.round(((present + leave) / total) * 10000) / 100 : 0;
      return {
        housekeeper_id: hk.housekeeper_id,
        housekeeper_name: hk.name,
        total,
        present,
        leave,
        absent,
        attendance_rate: attendanceRate,
      };
    });

    sendResponse(res, true, "获取成功", result);
  }),
);

export default router;
