import { Router, Request, Response } from "express";
import db from "../db/database";
import {
  generateId,
  sendResponse,
  sendError,
  handleAsync,
  getPaginationParams,
  buildPaginationResult,
  checkRoomScheduleConflict,
} from "../utils/helpers";
import { TrainingClass, ClassSchedule, ClassStatus } from "../types";

const router = Router();

function getEnrolledCount(classId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM registrations WHERE class_id = ? AND status = 'enrolled'`,
      )
      .get(classId) as any
  ).count;
}

function getWaitingCount(classId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM registrations WHERE class_id = ? AND status = 'waiting'`,
      )
      .get(classId) as any
  ).count;
}

function populateClass(cls: any): TrainingClass {
  cls.enrolled_count = getEnrolledCount(cls.id);
  cls.waiting_count = getWaitingCount(cls.id);
  return cls;
}

function getClassWithJoins(id: string) {
  return db
    .prepare(
      `
    SELECT tc.*, tt.name as training_type_name,
           i.name as instructor_name, tr.name as room_name
    FROM training_classes tc
    LEFT JOIN training_types tt ON tc.training_type_id = tt.id
    LEFT JOIN instructors i ON tc.instructor_id = i.id
    LEFT JOIN training_rooms tr ON tc.room_id = tr.id
    WHERE tc.id = ?
  `,
    )
    .get(id);
}

function listClassesWithJoins(
  where: string,
  params: any[],
  limit: number,
  offset: number,
) {
  return db
    .prepare(
      `
    SELECT tc.*, tt.name as training_type_name,
           i.name as instructor_name, tr.name as room_name
    FROM training_classes tc
    LEFT JOIN training_types tt ON tc.training_type_id = tt.id
    LEFT JOIN instructors i ON tc.instructor_id = i.id
    LEFT JOIN training_rooms tr ON tc.room_id = tr.id
    ${where}
    ORDER BY tc.created_at DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(...params, limit, offset);
}

router.post(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const {
      training_type_id,
      name,
      description,
      instructor_id,
      room_id,
      capacity,
      start_date,
      end_date,
      total_hours,
      schedules,
    } = req.body;

    if (
      !training_type_id ||
      !name ||
      !instructor_id ||
      !room_id ||
      !start_date ||
      !end_date
    ) {
      return sendError(
        res,
        "缺少必要字段：培训类型、班级名称、讲师、培训室、起止日期",
      );
    }
    if (new Date(start_date) > new Date(end_date)) {
      return sendError(res, "开始日期不能晚于结束日期");
    }

    const typeExists = db
      .prepare("SELECT id FROM training_types WHERE id = ?")
      .get(training_type_id);
    const instructorExists = db
      .prepare("SELECT id FROM instructors WHERE id = ?")
      .get(instructor_id);
    const room = db
      .prepare("SELECT * FROM training_rooms WHERE id = ?")
      .get(room_id) as any;
    if (!typeExists) return sendError(res, "培训类型不存在");
    if (!instructorExists) return sendError(res, "讲师不存在");
    if (!room) return sendError(res, "培训室不存在");
    if (capacity > room.capacity)
      return sendError(res, `班级容量不能超过培训室容量(${room.capacity})`);

    const scheduleList = schedules && Array.isArray(schedules) ? schedules : [];
    const conflict = checkRoomScheduleConflict(room_id, scheduleList);
    if (conflict.conflict) return sendError(res, conflict.message);

    const id = generateId();
    const tx = db.transaction(() => {
      db.prepare(
        `
      INSERT INTO training_classes (id, training_type_id, name, description, instructor_id,
        room_id, capacity, start_date, end_date, total_hours, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enrolling')
    `,
      ).run(
        id,
        training_type_id,
        name,
        description || "",
        instructor_id,
        room_id,
        capacity || 0,
        start_date,
        end_date,
        total_hours || 0,
      );

      const insertSched = db.prepare(`
      INSERT INTO class_schedules (id, class_id, date, start_time, end_time, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
      for (const sched of scheduleList) {
        insertSched.run(
          generateId(),
          id,
          sched.date,
          sched.start_time,
          sched.end_time,
          sched.content || "",
        );
      }
    });

    try {
      tx();
      const created = populateClass(getClassWithJoins(id));
      sendResponse(res, true, "创建培训班成功", created, 201);
    } catch (err: any) {
      sendError(res, "创建失败: " + err.message);
    }
  }),
);

router.get(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const { page, pageSize, offset } = getPaginationParams(req.query);
    const { status, training_type_id, keyword, start_date, end_date } =
      req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    if (status) {
      conditions.push("tc.status = ?");
      params.push(status);
    }
    if (training_type_id) {
      conditions.push("tc.training_type_id = ?");
      params.push(training_type_id);
    }
    if (keyword) {
      conditions.push("(tc.name LIKE ? OR tt.name LIKE ?)");
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    if (start_date) {
      conditions.push("tc.end_date >= ?");
      params.push(start_date);
    }
    if (end_date) {
      conditions.push("tc.start_date <= ?");
      params.push(end_date);
    }

    const whereClause =
      conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const countQ = `SELECT COUNT(*) as count FROM training_classes tc
    LEFT JOIN training_types tt ON tc.training_type_id = tt.id ${whereClause}`;
    const total = (db.prepare(countQ).get(...params) as any).count;

    const rows = listClassesWithJoins(
      whereClause,
      params,
      pageSize,
      offset,
    ).map(populateClass);

    sendResponse(
      res,
      true,
      "获取成功",
      buildPaginationResult(rows, total, page, pageSize),
    );
  }),
);

router.get(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const row = getClassWithJoins(req.params.id);
    if (!row) return sendError(res, "培训班不存在", undefined, 404);
    const result: any = populateClass(row);
    result.schedules = db
      .prepare(
        `SELECT * FROM class_schedules WHERE class_id = ? ORDER BY date, start_time`,
      )
      .all(req.params.id);
    sendResponse(res, true, "获取成功", result);
  }),
);

router.put(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const existing = db
      .prepare("SELECT * FROM training_classes WHERE id = ?")
      .get(req.params.id) as any;
    if (!existing) return sendError(res, "培训班不存在", undefined, 404);
    if (existing.status !== "enrolling") {
      return sendError(res, "只有招生中的班级可以修改基本信息");
    }

    const {
      training_type_id,
      name,
      description,
      instructor_id,
      room_id,
      capacity,
      start_date,
      end_date,
      total_hours,
      schedules,
    } = req.body;

    const newRoomId = room_id || existing.room_id;
    const newCapacity = capacity !== undefined ? capacity : existing.capacity;

    const room = db
      .prepare("SELECT * FROM training_rooms WHERE id = ?")
      .get(newRoomId) as any;
    if (!room) return sendError(res, "培训室不存在");
    if (newCapacity > room.capacity) {
      return sendError(res, `班级容量不能超过培训室容量(${room.capacity})`);
    }

    let scheduleList: any[] = [];
    if (schedules && Array.isArray(schedules)) {
      scheduleList = schedules;
      const conflict = checkRoomScheduleConflict(
        newRoomId,
        scheduleList,
        req.params.id,
      );
      if (conflict.conflict) return sendError(res, conflict.message);
    }

    const newStart = start_date || existing.start_date;
    const newEnd = end_date || existing.end_date;
    if (new Date(newStart) > new Date(newEnd)) {
      return sendError(res, "开始日期不能晚于结束日期");
    }

    const tx = db.transaction(() => {
      db.prepare(
        `
      UPDATE training_classes SET training_type_id=?, name=?, description=?, instructor_id=?,
        room_id=?, capacity=?, start_date=?, end_date=?, total_hours=?, updated_at=datetime('now')
      WHERE id = ?
    `,
      ).run(
        training_type_id || existing.training_type_id,
        name || existing.name,
        description !== undefined ? description : existing.description,
        instructor_id || existing.instructor_id,
        newRoomId,
        newCapacity,
        newStart,
        newEnd,
        total_hours !== undefined ? total_hours : existing.total_hours,
        req.params.id,
      );

      if (schedules && Array.isArray(schedules)) {
        db.prepare("DELETE FROM class_schedules WHERE class_id = ?").run(
          req.params.id,
        );
        const insertSched = db.prepare(`
        INSERT INTO class_schedules (id, class_id, date, start_time, end_time, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
        for (const sched of scheduleList) {
          insertSched.run(
            generateId(),
            req.params.id,
            sched.date,
            sched.start_time,
            sched.end_time,
            sched.content || "",
          );
        }
      }
    });

    try {
      tx();
      const updated = populateClass(getClassWithJoins(req.params.id));
      sendResponse(res, true, "更新成功", updated);
    } catch (err: any) {
      sendError(res, "更新失败: " + err.message);
    }
  }),
);

router.delete(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const existing = db
      .prepare("SELECT status FROM training_classes WHERE id = ?")
      .get(req.params.id) as any;
    if (!existing) return sendError(res, "培训班不存在", undefined, 404);
    if (existing.status !== "enrolling") {
      return sendError(res, "只能删除招生中的班级");
    }
    db.prepare("DELETE FROM training_classes WHERE id = ?").run(req.params.id);
    sendResponse(res, true, "删除成功");
  }),
);

router.post(
  "/:id/start",
  handleAsync(async (req: Request, res: Response) => {
    const existing = db
      .prepare("SELECT * FROM training_classes WHERE id = ?")
      .get(req.params.id) as any;
    if (!existing) return sendError(res, "培训班不存在", undefined, 404);
    if (existing.status !== "enrolling")
      return sendError(res, "只有招生中的班级可以开班");

    const enrolled = getEnrolledCount(req.params.id);
    if (enrolled === 0) return sendError(res, "没有正式学员，无法开班");

    db.prepare(
      `UPDATE training_classes SET status='started', updated_at=datetime('now') WHERE id=?`,
    ).run(req.params.id);
    const updated = populateClass(getClassWithJoins(req.params.id));
    sendResponse(res, true, "班级已开班", updated);
  }),
);

router.post(
  "/:id/begin-training",
  handleAsync(async (req: Request, res: Response) => {
    const existing = db
      .prepare("SELECT * FROM training_classes WHERE id = ?")
      .get(req.params.id) as any;
    if (!existing) return sendError(res, "培训班不存在", undefined, 404);
    if (!["started", "in_training"].includes(existing.status)) {
      return sendError(res, "只有已开班的班级才能进入培训中状态");
    }
    db.prepare(
      `UPDATE training_classes SET status='in_training', updated_at=datetime('now') WHERE id=?`,
    ).run(req.params.id);
    const updated = populateClass(getClassWithJoins(req.params.id));
    sendResponse(res, true, "班级进入培训中状态", updated);
  }),
);

export default router;
