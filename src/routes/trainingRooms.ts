import { Router, Request, Response } from "express";
import db from "../db/database";
import {
  generateId,
  sendResponse,
  sendError,
  handleAsync,
  getPaginationParams,
  buildPaginationResult,
} from "../utils/helpers";
import { TrainingRoom } from "../types";

const router = Router();

router.post(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const { name, location, capacity, equipment } = req.body;
    if (!name) {
      return sendError(res, "培训室名称不能为空");
    }
    const id = generateId();
    const stmt = db.prepare(`
    INSERT INTO training_rooms (id, name, location, capacity, equipment)
    VALUES (?, ?, ?, ?, ?)
  `);
    try {
      stmt.run(id, name, location || "", capacity || 0, equipment || "");
      const record = db
        .prepare("SELECT * FROM training_rooms WHERE id = ?")
        .get(id) as TrainingRoom;
      sendResponse(res, true, "创建培训室成功", record, 201);
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        sendError(res, "培训室名称已存在");
      } else {
        sendError(res, "创建失败: " + err.message);
      }
    }
  }),
);

router.get(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const { page, pageSize, offset } = getPaginationParams(req.query);
    const { keyword, min_capacity } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    if (keyword) {
      conditions.push("(name LIKE ? OR location LIKE ?)");
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    if (min_capacity) {
      conditions.push("capacity >= ?");
      params.push(parseInt(min_capacity as string));
    }
    const whereClause =
      conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const total = (
      db
        .prepare(`SELECT COUNT(*) as count FROM training_rooms ${whereClause}`)
        .get(...params) as any
    ).count;
    const rows = db
      .prepare(
        `SELECT * FROM training_rooms ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as TrainingRoom[];

    sendResponse(
      res,
      true,
      "获取成功",
      buildPaginationResult(rows, total, page, pageSize),
    );
  }),
);

router.get(
  "/all",
  handleAsync(async (req: Request, res: Response) => {
    const rows = db
      .prepare("SELECT * FROM training_rooms ORDER BY name ASC")
      .all() as TrainingRoom[];
    sendResponse(res, true, "获取成功", rows);
  }),
);

router.get(
  "/:id/availability",
  handleAsync(async (req: Request, res: Response) => {
    const { start_date, end_date } = req.query as any;
    if (!start_date || !end_date) {
      return sendError(res, "请提供 start_date 和 end_date 参数");
    }
    const classSchedules = db
      .prepare(
        `
    SELECT cs.date, cs.start_time, cs.end_time, tc.name as class_name,
           'normal' as schedule_type
    FROM class_schedules cs
    JOIN training_classes tc ON cs.class_id = tc.id
    WHERE cs.room_id = ? AND cs.date BETWEEN ? AND ?
    ORDER BY cs.date, cs.start_time
  `,
      )
      .all(req.params.id, start_date, end_date);

    const makeupSchedules = db
      .prepare(
        `
    SELECT ms.date, ms.start_time, ms.end_time, tc.name as class_name,
           'makeup' as schedule_type
    FROM makeup_schedules ms
    JOIN training_classes tc ON ms.class_id = tc.id
    WHERE ms.room_id = ? AND ms.date BETWEEN ? AND ?
    ORDER BY ms.date, ms.start_time
  `,
      )
      .all(req.params.id, start_date, end_date);

    const allSchedules = [...classSchedules, ...makeupSchedules].sort(
      (a: any, b: any) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.start_time < b.start_time ? -1 : 1;
      },
    );
    sendResponse(res, true, "获取占用情况成功", allSchedules);
  }),
);

router.get(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const row = db
      .prepare("SELECT * FROM training_rooms WHERE id = ?")
      .get(req.params.id) as TrainingRoom;
    if (!row) {
      return sendError(res, "培训室不存在", undefined, 404);
    }
    sendResponse(res, true, "获取成功", row);
  }),
);

router.put(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const { name, location, capacity, equipment } = req.body;
    const existing = db
      .prepare("SELECT * FROM training_rooms WHERE id = ?")
      .get(req.params.id);
    if (!existing) {
      return sendError(res, "培训室不存在", undefined, 404);
    }
    const stmt = db.prepare(`
    UPDATE training_rooms SET name = ?, location = ?, capacity = ?, equipment = ?
    WHERE id = ?
  `);
    try {
      stmt.run(
        name,
        location || "",
        capacity || 0,
        equipment || "",
        req.params.id,
      );
      const updated = db
        .prepare("SELECT * FROM training_rooms WHERE id = ?")
        .get(req.params.id);
      sendResponse(res, true, "更新成功", updated);
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        sendError(res, "培训室名称已存在");
      } else {
        sendError(res, "更新失败: " + err.message);
      }
    }
  }),
);

router.delete(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const using = db
      .prepare(
        "SELECT COUNT(*) as count FROM training_classes WHERE room_id = ?",
      )
      .get(req.params.id) as any;
    if (using.count > 0) {
      return sendError(res, "该培训室已被使用，无法删除");
    }
    const result = db
      .prepare("DELETE FROM training_rooms WHERE id = ?")
      .run(req.params.id);
    if (result.changes === 0) {
      return sendError(res, "培训室不存在", undefined, 404);
    }
    sendResponse(res, true, "删除成功");
  }),
);

export default router;
