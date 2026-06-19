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
import { Instructor } from "../types";

const router = Router();

router.post(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const { name, phone, specialty } = req.body;
    if (!name) {
      return sendError(res, "讲师姓名不能为空");
    }
    const id = generateId();
    const stmt = db.prepare(`
    INSERT INTO instructors (id, name, phone, specialty)
    VALUES (?, ?, ?, ?)
  `);
    stmt.run(id, name, phone || "", specialty || "");
    const record = db
      .prepare("SELECT * FROM instructors WHERE id = ?")
      .get(id) as Instructor;
    sendResponse(res, true, "创建讲师成功", record, 201);
  }),
);

router.get(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const { page, pageSize, offset } = getPaginationParams(req.query);
    const { keyword, specialty } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    if (keyword) {
      conditions.push("(name LIKE ? OR phone LIKE ?)");
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    if (specialty) {
      conditions.push("specialty LIKE ?");
      params.push(`%${specialty}%`);
    }
    const whereClause =
      conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const total = (
      db
        .prepare(`SELECT COUNT(*) as count FROM instructors ${whereClause}`)
        .get(...params) as any
    ).count;
    const rows = db
      .prepare(
        `SELECT * FROM instructors ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as Instructor[];

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
      .prepare("SELECT * FROM instructors ORDER BY name ASC")
      .all() as Instructor[];
    sendResponse(res, true, "获取成功", rows);
  }),
);

router.get(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const row = db
      .prepare("SELECT * FROM instructors WHERE id = ?")
      .get(req.params.id) as Instructor;
    if (!row) {
      return sendError(res, "讲师不存在", undefined, 404);
    }
    sendResponse(res, true, "获取成功", row);
  }),
);

router.put(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const { name, phone, specialty } = req.body;
    const existing = db
      .prepare("SELECT * FROM instructors WHERE id = ?")
      .get(req.params.id);
    if (!existing) {
      return sendError(res, "讲师不存在", undefined, 404);
    }
    const stmt = db.prepare(`
    UPDATE instructors SET name = ?, phone = ?, specialty = ?
    WHERE id = ?
  `);
    stmt.run(name, phone || "", specialty || "", req.params.id);
    const updated = db
      .prepare("SELECT * FROM instructors WHERE id = ?")
      .get(req.params.id);
    sendResponse(res, true, "更新成功", updated);
  }),
);

router.delete(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const using = db
      .prepare(
        "SELECT COUNT(*) as count FROM training_classes WHERE instructor_id = ?",
      )
      .get(req.params.id) as any;
    if (using.count > 0) {
      return sendError(res, "该讲师已被使用，无法删除");
    }
    const result = db
      .prepare("DELETE FROM instructors WHERE id = ?")
      .run(req.params.id);
    if (result.changes === 0) {
      return sendError(res, "讲师不存在", undefined, 404);
    }
    sendResponse(res, true, "删除成功");
  }),
);

export default router;
