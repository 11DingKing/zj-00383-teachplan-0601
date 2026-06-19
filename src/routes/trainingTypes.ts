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
import { TrainingType } from "../types";

const router = Router();

router.post(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const { name, description, default_duration_hours } = req.body;
    if (!name) {
      return sendError(res, "培训类型名称不能为空");
    }
    const id = generateId();
    const stmt = db.prepare(`
    INSERT INTO training_types (id, name, description, default_duration_hours)
    VALUES (?, ?, ?, ?)
  `);
    try {
      stmt.run(id, name, description || "", default_duration_hours || 0);
      const record = db
        .prepare("SELECT * FROM training_types WHERE id = ?")
        .get(id) as TrainingType;
      sendResponse(res, true, "创建培训类型成功", record, 201);
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        sendError(res, "培训类型名称已存在");
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
    const { keyword } = req.query;

    let whereClause = "";
    const params: any[] = [];
    if (keyword) {
      whereClause = "WHERE name LIKE ?";
      params.push(`%${keyword}%`);
    }

    const total = (
      db
        .prepare(`SELECT COUNT(*) as count FROM training_types ${whereClause}`)
        .get(...params) as any
    ).count;
    const rows = db
      .prepare(
        `SELECT * FROM training_types ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as TrainingType[];

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
      .prepare("SELECT * FROM training_types ORDER BY created_at DESC")
      .all() as TrainingType[];
    sendResponse(res, true, "获取成功", rows);
  }),
);

router.get(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const row = db
      .prepare("SELECT * FROM training_types WHERE id = ?")
      .get(req.params.id) as TrainingType;
    if (!row) {
      return sendError(res, "培训类型不存在", undefined, 404);
    }
    sendResponse(res, true, "获取成功", row);
  }),
);

router.put(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const { name, description, default_duration_hours } = req.body;
    const existing = db
      .prepare("SELECT * FROM training_types WHERE id = ?")
      .get(req.params.id);
    if (!existing) {
      return sendError(res, "培训类型不存在", undefined, 404);
    }
    const stmt = db.prepare(`
    UPDATE training_types SET name = ?, description = ?, default_duration_hours = ?
    WHERE id = ?
  `);
    try {
      stmt.run(
        name,
        description || "",
        default_duration_hours || 0,
        req.params.id,
      );
      const updated = db
        .prepare("SELECT * FROM training_types WHERE id = ?")
        .get(req.params.id);
      sendResponse(res, true, "更新成功", updated);
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        sendError(res, "培训类型名称已存在");
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
        "SELECT COUNT(*) as count FROM training_classes WHERE training_type_id = ?",
      )
      .get(req.params.id) as any;
    if (using.count > 0) {
      return sendError(res, "该培训类型已被使用，无法删除");
    }
    const result = db
      .prepare("DELETE FROM training_types WHERE id = ?")
      .run(req.params.id);
    if (result.changes === 0) {
      return sendError(res, "培训类型不存在", undefined, 404);
    }
    sendResponse(res, true, "删除成功");
  }),
);

export default router;
