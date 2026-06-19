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
import { Housekeeper, SkillRecord } from "../types";

const router = Router();

router.post(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const { name, id_card, phone, gender, birth_date, address } = req.body;
    if (!name) {
      return sendError(res, "家政人员姓名不能为空");
    }
    const id = generateId();
    const stmt = db.prepare(`
    INSERT INTO housekeepers (id, name, id_card, phone, gender, birth_date, address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
    try {
      stmt.run(
        id,
        name,
        id_card || "",
        phone || "",
        gender || "female",
        birth_date || "",
        address || "",
      );
      const record = db
        .prepare("SELECT * FROM housekeepers WHERE id = ?")
        .get(id) as Housekeeper;
      sendResponse(res, true, "创建家政人员档案成功", record, 201);
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        sendError(res, "身份证号已存在");
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
    const { keyword, gender } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    if (keyword) {
      conditions.push("(name LIKE ? OR id_card LIKE ? OR phone LIKE ?)");
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (gender) {
      conditions.push("gender = ?");
      params.push(gender);
    }
    const whereClause =
      conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const total = (
      db
        .prepare(`SELECT COUNT(*) as count FROM housekeepers ${whereClause}`)
        .get(...params) as any
    ).count;
    const rows = db
      .prepare(
        `SELECT * FROM housekeepers ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as Housekeeper[];

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
    const row = db
      .prepare("SELECT * FROM housekeepers WHERE id = ?")
      .get(req.params.id) as Housekeeper;
    if (!row) {
      return sendError(res, "家政人员不存在", undefined, 404);
    }
    sendResponse(res, true, "获取成功", row);
  }),
);

router.get(
  "/:id/skill-records",
  handleAsync(async (req: Request, res: Response) => {
    const rows = db
      .prepare(
        `
    SELECT sr.*, tc.name as class_name, tt.name as training_type_name
    FROM skill_records sr
    LEFT JOIN training_classes tc ON sr.class_id = tc.id
    LEFT JOIN training_types tt ON sr.training_type_id = tt.id
    WHERE sr.housekeeper_id = ?
    ORDER BY sr.recorded_at DESC
  `,
      )
      .all(req.params.id) as SkillRecord[];
    sendResponse(res, true, "获取技能档案成功", rows);
  }),
);

router.put(
  "/:id",
  handleAsync(async (req: Request, res: Response) => {
    const { name, id_card, phone, gender, birth_date, address } = req.body;
    const existing = db
      .prepare("SELECT * FROM housekeepers WHERE id = ?")
      .get(req.params.id);
    if (!existing) {
      return sendError(res, "家政人员不存在", undefined, 404);
    }
    const stmt = db.prepare(`
    UPDATE housekeepers SET name = ?, id_card = ?, phone = ?, gender = ?, birth_date = ?, address = ?
    WHERE id = ?
  `);
    try {
      stmt.run(
        name,
        id_card || "",
        phone || "",
        gender || "female",
        birth_date || "",
        address || "",
        req.params.id,
      );
      const updated = db
        .prepare("SELECT * FROM housekeepers WHERE id = ?")
        .get(req.params.id);
      sendResponse(res, true, "更新成功", updated);
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        sendError(res, "身份证号已存在");
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
        `
    SELECT COUNT(*) as count FROM (
      SELECT id FROM registrations WHERE housekeeper_id = ?
      UNION ALL
      SELECT id FROM skill_records WHERE housekeeper_id = ?
    )
  `,
      )
      .get(req.params.id, req.params.id) as any;
    if (using.count > 0) {
      return sendError(res, "该家政人员已有培训记录，无法删除");
    }
    const result = db
      .prepare("DELETE FROM housekeepers WHERE id = ?")
      .run(req.params.id);
    if (result.changes === 0) {
      return sendError(res, "家政人员不存在", undefined, 404);
    }
    sendResponse(res, true, "删除成功");
  }),
);

export default router;
