import { Router, Request, Response } from "express";
import db from "../db/database";
import {
  generateId,
  sendResponse,
  sendError,
  handleAsync,
  getAbsentList,
  calcAttendanceRate,
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
      INSERT INTO attendances (id, class_id, schedule_id, housekeeper_id, status, remark, is_makeup, original_schedule_id, makeup_schedule_id)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL)
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

    const makeupRows = db
      .prepare(
        `
    SELECT a.*, ms.date, ms.start_time, ms.end_time, ms.content,
           cs_original.date as original_date, cs_original.content as original_content
    FROM attendances a
    LEFT JOIN makeup_schedules ms ON a.makeup_schedule_id = ms.id
    LEFT JOIN class_schedules cs_original ON a.original_schedule_id = cs_original.id
    WHERE a.class_id = ? AND a.housekeeper_id = ? AND a.is_makeup = 1
    ORDER BY ms.date, ms.start_time
  `,
      )
      .all(classId, housekeeperId);

    const total = rows.length;
    const present = rows.filter((r: any) => r.status === "present").length;
    const leave = rows.filter((r: any) => r.status === "leave").length;
    const absent = rows.filter((r: any) => r.status === "absent").length;
    const attendanceRate = calcAttendanceRate(classId, housekeeperId);
    const makeupCount = makeupRows.filter(
      (r: any) => r.status === "present" || r.status === "leave",
    ).length;

    sendResponse(res, true, "获取成功", {
      records: rows,
      makeup_records: makeupRows,
      summary: {
        total,
        present,
        leave,
        absent,
        makeup_count: makeupCount,
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
      SELECT a.status, a.is_makeup, a.original_schedule_id FROM attendances a
      WHERE a.class_id = ? AND a.housekeeper_id = ?
    `,
        )
        .all(classId, hk.housekeeper_id) as any[];
      const total = rows.filter((r) => !r.is_makeup).length;
      const present = rows.filter(
        (r) => !r.is_makeup && r.status === "present",
      ).length;
      const leave = rows.filter(
        (r) => !r.is_makeup && r.status === "leave",
      ).length;
      const absent = rows.filter(
        (r) => !r.is_makeup && r.status === "absent",
      ).length;
      const makeupCount = rows.filter(
        (r) =>
          r.is_makeup === 1 && (r.status === "present" || r.status === "leave"),
      ).length;
      const attendanceRate = calcAttendanceRate(classId, hk.housekeeper_id);
      return {
        housekeeper_id: hk.housekeeper_id,
        housekeeper_name: hk.name,
        total,
        present,
        leave,
        absent,
        makeup_count: makeupCount,
        attendance_rate: attendanceRate,
      };
    });

    sendResponse(res, true, "获取成功", result);
  }),
);

router.get(
  "/class/:classId/absent-list",
  handleAsync(async (req: Request, res: Response) => {
    const { classId } = req.params;
    const list = getAbsentList(classId);
    sendResponse(res, true, "获取缺勤列表成功", {
      total: list.length,
      items: list,
    });
  }),
);

router.post(
  "/makeup/schedule",
  handleAsync(async (req: Request, res: Response) => {
    const {
      class_id,
      original_schedule_id,
      date,
      start_time,
      end_time,
      content,
      room_id,
      instructor_id,
      created_by,
    } = req.body;

    if (
      !class_id ||
      !original_schedule_id ||
      !date ||
      !start_time ||
      !end_time
    ) {
      return sendError(res, "请提供班级ID、原课程ID、补课日期、开始和结束时间");
    }

    const cls = db
      .prepare("SELECT * FROM training_classes WHERE id = ?")
      .get(class_id) as any;
    if (!cls) return sendError(res, "培训班不存在", undefined, 404);

    const originalSched = db
      .prepare("SELECT * FROM class_schedules WHERE id = ? AND class_id = ?")
      .get(original_schedule_id, class_id);
    if (!originalSched)
      return sendError(res, "原课程安排不存在", undefined, 404);

    const id = generateId();
    db.prepare(
      `
      INSERT INTO makeup_schedules (id, class_id, original_schedule_id, date, start_time, end_time, content, room_id, instructor_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      class_id,
      original_schedule_id,
      date,
      start_time,
      end_time,
      content || (originalSched as any).content || "",
      room_id || null,
      instructor_id || null,
      created_by || "",
    );

    const saved = db
      .prepare(
        `
      SELECT ms.*, cs.content as original_schedule_content,
             tr.name as room_name, i.name as instructor_name
      FROM makeup_schedules ms
      LEFT JOIN class_schedules cs ON ms.original_schedule_id = cs.id
      LEFT JOIN training_rooms tr ON ms.room_id = tr.id
      LEFT JOIN instructors i ON ms.instructor_id = i.id
      WHERE ms.id = ?
    `,
      )
      .get(id);
    sendResponse(res, true, "补课安排创建成功", saved, 201);
  }),
);

router.get(
  "/makeup/schedule/class/:classId",
  handleAsync(async (req: Request, res: Response) => {
    const rows = db
      .prepare(
        `
      SELECT ms.*, cs.content as original_schedule_content, cs.date as original_date,
             tr.name as room_name, i.name as instructor_name
      FROM makeup_schedules ms
      LEFT JOIN class_schedules cs ON ms.original_schedule_id = cs.id
      LEFT JOIN training_rooms tr ON ms.room_id = tr.id
      LEFT JOIN instructors i ON ms.instructor_id = i.id
      WHERE ms.class_id = ?
      ORDER BY ms.date, ms.start_time
    `,
      )
      .all(req.params.classId);
    sendResponse(res, true, "获取补课安排成功", rows);
  }),
);

router.get(
  "/makeup/schedule/:scheduleId",
  handleAsync(async (req: Request, res: Response) => {
    const row = db
      .prepare(
        `
      SELECT ms.*, cs.content as original_schedule_content, cs.date as original_date,
             tr.name as room_name, i.name as instructor_name
      FROM makeup_schedules ms
      LEFT JOIN class_schedules cs ON ms.original_schedule_id = cs.id
      LEFT JOIN training_rooms tr ON ms.room_id = tr.id
      LEFT JOIN instructors i ON ms.instructor_id = i.id
      WHERE ms.id = ?
    `,
      )
      .get(req.params.scheduleId);
    if (!row) return sendError(res, "补课安排不存在", undefined, 404);

    const registrations = db
      .prepare(
        `
      SELECT mr.*, h.name as housekeeper_name, h.phone as housekeeper_phone
      FROM makeup_registrations mr
      LEFT JOIN housekeepers h ON mr.housekeeper_id = h.id
      WHERE mr.makeup_schedule_id = ?
      ORDER BY mr.registered_at
    `,
      )
      .all(req.params.scheduleId);

    sendResponse(res, true, "获取成功", {
      schedule: row,
      registrations,
    });
  }),
);

router.post(
  "/makeup/register",
  handleAsync(async (req: Request, res: Response) => {
    const { makeup_schedule_id, housekeeper_ids } = req.body;
    if (
      !makeup_schedule_id ||
      !Array.isArray(housekeeper_ids) ||
      housekeeper_ids.length === 0
    ) {
      return sendError(res, "请提供补课安排ID和需要补课的学员ID列表");
    }

    const ms = db
      .prepare("SELECT * FROM makeup_schedules WHERE id = ?")
      .get(makeup_schedule_id) as any;
    if (!ms) return sendError(res, "补课安排不存在", undefined, 404);

    const tx = db.transaction(() => {
      const insert = db.prepare(`
        INSERT INTO makeup_registrations (id, makeup_schedule_id, housekeeper_id, original_schedule_id, class_id, status)
        VALUES (?, ?, ?, ?, ?, 'scheduled')
        ON CONFLICT(makeup_schedule_id, housekeeper_id) DO NOTHING
      `);
      for (const hkId of housekeeper_ids) {
        insert.run(
          generateId(),
          makeup_schedule_id,
          hkId,
          ms.original_schedule_id,
          ms.class_id,
        );
      }
    });

    try {
      tx();
      const saved = db
        .prepare(
          `
        SELECT mr.*, h.name as housekeeper_name
        FROM makeup_registrations mr
        LEFT JOIN housekeepers h ON mr.housekeeper_id = h.id
        WHERE mr.makeup_schedule_id = ?
        ORDER BY h.name
      `,
        )
        .all(makeup_schedule_id);
      sendResponse(res, true, "补课登记成功", saved);
    } catch (err: any) {
      sendError(res, "登记失败: " + err.message);
    }
  }),
);

router.post(
  "/makeup/attendance",
  handleAsync(async (req: Request, res: Response) => {
    const { makeup_schedule_id, records } = req.body;
    if (
      !makeup_schedule_id ||
      !Array.isArray(records) ||
      records.length === 0
    ) {
      return sendError(res, "请提供补课安排ID和考勤记录数组");
    }

    const ms = db
      .prepare(
        `
      SELECT ms.*, tc.status as class_status
      FROM makeup_schedules ms
      JOIN training_classes tc ON ms.class_id = tc.id
      WHERE ms.id = ?
    `,
      )
      .get(makeup_schedule_id) as any;
    if (!ms) return sendError(res, "补课安排不存在", undefined, 404);
    if (!["started", "in_training"].includes(ms.class_status)) {
      return sendError(res, "只有已开班或培训中的班级可以记录补课考勤");
    }

    const tx = db.transaction(() => {
      const upsert = db.prepare(`
        INSERT INTO attendances (id, class_id, schedule_id, housekeeper_id, status, remark, is_makeup, original_schedule_id, makeup_schedule_id)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(schedule_id, housekeeper_id) DO UPDATE SET
          status = excluded.status,
          remark = excluded.remark,
          recorded_at = datetime('now')
      `);
      const updateReg = db.prepare(
        `UPDATE makeup_registrations SET status = 'completed' WHERE makeup_schedule_id = ? AND housekeeper_id = ?`,
      );
      for (const rec of records) {
        const validStatus = ["present", "absent", "leave"].includes(rec.status)
          ? rec.status
          : "present";
        const fakeScheduleId = `makeup_${makeup_schedule_id}`;
        upsert.run(
          generateId(),
          ms.class_id,
          fakeScheduleId,
          rec.housekeeper_id,
          validStatus,
          rec.remark || "",
          ms.original_schedule_id,
          makeup_schedule_id,
        );
        if (validStatus === "present" || validStatus === "leave") {
          updateReg.run(makeup_schedule_id, rec.housekeeper_id);
        }
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
        WHERE a.makeup_schedule_id = ?
        ORDER BY h.name ASC
      `,
        )
        .all(makeup_schedule_id);
      sendResponse(res, true, "补课考勤记录已保存", saved);
    } catch (err: any) {
      sendError(res, "保存失败: " + err.message);
    }
  }),
);

router.get(
  "/makeup/schedule/:scheduleId/attendance",
  handleAsync(async (req: Request, res: Response) => {
    const { scheduleId } = req.params;
    const schedule = db
      .prepare(
        `
      SELECT ms.*, tc.name as class_name, tc.status as class_status
      FROM makeup_schedules ms
      LEFT JOIN training_classes tc ON ms.class_id = tc.id
      WHERE ms.id = ?
    `,
      )
      .get(scheduleId);
    if (!schedule) return sendError(res, "补课安排不存在", undefined, 404);

    const attendances = db
      .prepare(
        `
      SELECT a.*, h.name as housekeeper_name, h.id_card as housekeeper_id_card
      FROM attendances a
      LEFT JOIN housekeepers h ON a.housekeeper_id = h.id
      WHERE a.makeup_schedule_id = ?
      ORDER BY h.name ASC
    `,
      )
      .all(scheduleId);

    const registered = db
      .prepare(
        `
      SELECT DISTINCT mr.housekeeper_id, h.name as housekeeper_name, h.id_card as housekeeper_id_card
      FROM makeup_registrations mr
      LEFT JOIN housekeepers h ON mr.housekeeper_id = h.id
      WHERE mr.makeup_schedule_id = ?
      ORDER BY h.name ASC
    `,
      )
      .all(scheduleId);

    const byId = new Map<string, any>(
      attendances.map((a: any) => [a.housekeeper_id, a]),
    );
    const combined = registered.map((e: any) => {
      const att: any | undefined = byId.get(e.housekeeper_id);
      return {
        housekeeper_id: e.housekeeper_id,
        housekeeper_name: e.housekeeper_name,
        housekeeper_id_card: e.housekeeper_id_card,
        status: att ? att.status : null,
        remark: att ? att.remark : "",
      };
    });

    sendResponse(res, true, "获取成功", {
      schedule,
      attendances: combined,
    });
  }),
);

export default router;
