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
import { Registration, RegistrationStatus } from "../types";

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

function recalcWaitPositions(classId: string) {
  const waiting = db
    .prepare(
      `
    SELECT id FROM registrations
    WHERE class_id = ? AND status = 'waiting'
    ORDER BY registered_at ASC
  `,
    )
    .all(classId) as any[];
  const updateStmt = db.prepare(
    `UPDATE registrations SET wait_position = ? WHERE id = ?`,
  );
  waiting.forEach((r, idx) => updateStmt.run(idx + 1, r.id));
}

function promoteNextWaiter(classId: string): any | null {
  const waiter = db
    .prepare(
      `
    SELECT r.*, h.name as housekeeper_name, h.phone as housekeeper_phone
    FROM registrations r
    JOIN housekeepers h ON r.housekeeper_id = h.id
    WHERE r.class_id = ? AND r.status = 'waiting'
    ORDER BY r.registered_at ASC
    LIMIT 1
  `,
    )
    .get(classId);
  if (waiter) {
    const w: any = waiter;
    db.prepare(
      `UPDATE registrations SET status = 'enrolled', wait_position = NULL, promoted_at = datetime('now') WHERE id = ?`,
    ).run(w.id);
    recalcWaitPositions(classId);
    const schedules = db
      .prepare(
        `SELECT * FROM class_schedules WHERE class_id = ? ORDER BY date, start_time`,
      )
      .all(classId);
    w.schedules = schedules;
  }
  return waiter;
}

router.post(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const { class_id, housekeeper_id } = req.body;
    if (!class_id || !housekeeper_id) {
      return sendError(res, "请提供班级ID和家政人员ID");
    }

    const cls = db
      .prepare("SELECT * FROM training_classes WHERE id = ?")
      .get(class_id) as any;
    if (!cls) return sendError(res, "培训班不存在", undefined, 404);
    if (cls.status !== "enrolling") return sendError(res, "只能在招生阶段报名");

    const hk = db
      .prepare("SELECT id FROM housekeepers WHERE id = ?")
      .get(housekeeper_id);
    if (!hk) return sendError(res, "家政人员不存在", undefined, 404);

    const existing = db
      .prepare(
        `
    SELECT * FROM registrations WHERE class_id = ? AND housekeeper_id = ?
  `,
      )
      .get(class_id, housekeeper_id);
    if (existing && (existing as any).status !== "cancelled") {
      return sendError(res, "该人员已报名此班级");
    }

    const id = generateId();
    const tx = db.transaction(() => {
      if (existing) {
        db.prepare(
          `UPDATE registrations SET status = 'cancelled' WHERE id = ?`,
        ).run((existing as any).id);
      }
      const enrolled = getEnrolledCount(class_id);
      let status: RegistrationStatus = "enrolled";
      let waitPosition: number | null = null;
      if (enrolled >= cls.capacity) {
        status = "waiting";
        const waitCount = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM registrations WHERE class_id = ? AND status = 'waiting'`,
            )
            .get(class_id) as any
        ).count;
        waitPosition = waitCount + 1;
      }
      db.prepare(
        `
      INSERT INTO registrations (id, class_id, housekeeper_id, status, wait_position)
      VALUES (?, ?, ?, ?, ?)
    `,
      ).run(id, class_id, housekeeper_id, status, waitPosition);
    });

    try {
      tx();
      const record = db
        .prepare(
          `
      SELECT r.*, tc.name as class_name, h.name as housekeeper_name
      FROM registrations r
      LEFT JOIN training_classes tc ON r.class_id = tc.id
      LEFT JOIN housekeepers h ON r.housekeeper_id = h.id
      WHERE r.id = ?
    `,
        )
        .get(id);
      const msg =
        (record as any).status === "waiting"
          ? "报名成功，已进入候补队列"
          : "报名成功";
      sendResponse(res, true, msg, record, 201);
    } catch (err: any) {
      sendError(res, "报名失败: " + err.message);
    }
  }),
);

router.get(
  "/",
  handleAsync(async (req: Request, res: Response) => {
    const { page, pageSize, offset } = getPaginationParams(req.query);
    const { class_id, housekeeper_id, status } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    if (class_id) {
      conditions.push("r.class_id = ?");
      params.push(class_id);
    }
    if (housekeeper_id) {
      conditions.push("r.housekeeper_id = ?");
      params.push(housekeeper_id);
    }
    if (status) {
      conditions.push("r.status = ?");
      params.push(status);
    }
    const whereClause =
      conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const total = (
      db
        .prepare(`SELECT COUNT(*) as count FROM registrations r ${whereClause}`)
        .get(...params) as any
    ).count;
    const rows = db
      .prepare(
        `
    SELECT r.*, tc.name as class_name, h.name as housekeeper_name,
           h.phone as housekeeper_phone
    FROM registrations r
    LEFT JOIN training_classes tc ON r.class_id = tc.id
    LEFT JOIN housekeepers h ON r.housekeeper_id = h.id
    ${whereClause}
    ORDER BY r.registered_at DESC
    LIMIT ? OFFSET ?
  `,
      )
      .all(...params, pageSize, offset) as Registration[];

    sendResponse(
      res,
      true,
      "获取成功",
      buildPaginationResult(rows, total, page, pageSize),
    );
  }),
);

router.get(
  "/class/:classId",
  handleAsync(async (req: Request, res: Response) => {
    const { status } = req.query as any;
    const conditions: string[] = ["r.class_id = ?"];
    const params: any[] = [req.params.classId];
    if (status) {
      conditions.push("r.status = ?");
      params.push(status);
    }
    const whereClause = "WHERE " + conditions.join(" AND ");
    const orderBy =
      status === "waiting" ? "r.wait_position ASC" : "r.registered_at ASC";
    const rows = db
      .prepare(
        `
    SELECT r.*, h.name as housekeeper_name, h.id_card as housekeeper_id_card,
           h.phone as housekeeper_phone
    FROM registrations r
    LEFT JOIN housekeepers h ON r.housekeeper_id = h.id
    ${whereClause}
    ORDER BY ${orderBy}
  `,
      )
      .all(...params);
    sendResponse(res, true, "获取成功", rows);
  }),
);

router.delete(
  "/:id/cancel",
  handleAsync(async (req: Request, res: Response) => {
    const reg = db
      .prepare("SELECT * FROM registrations WHERE id = ?")
      .get(req.params.id) as any;
    if (!reg) return sendError(res, "报名记录不存在", undefined, 404);
    if (reg.status === "cancelled") return sendError(res, "该报名已取消");

    const cls = db
      .prepare("SELECT status FROM training_classes WHERE id = ?")
      .get(reg.class_id) as any;
    if (cls.status === "completed")
      return sendError(res, "班级已结业，无法取消报名");

    let promotedWaiter: any = null;
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE registrations SET status = 'cancelled', wait_position = NULL WHERE id = ?`,
      ).run(req.params.id);
      if (reg.status === "enrolled") {
        promotedWaiter = promoteNextWaiter(reg.class_id);
      } else {
        recalcWaitPositions(reg.class_id);
      }
    });

    try {
      tx();
      const data: any = { message: "取消成功" };
      if (promotedWaiter) {
        data.promoted_waiter = {
          id: promotedWaiter.id,
          housekeeper_id: promotedWaiter.housekeeper_id,
          housekeeper_name: promotedWaiter.housekeeper_name,
          housekeeper_phone: promotedWaiter.housekeeper_phone,
          promoted_at: new Date().toISOString(),
          schedules: promotedWaiter.schedules,
        };
        sendResponse(
          res,
          true,
          `取消成功，候补学员 ${promotedWaiter.housekeeper_name} 已自动转正并分配课程安排`,
          data,
        );
      } else {
        sendResponse(res, true, "取消成功，无候补学员可递补", data);
      }
    } catch (err: any) {
      sendError(res, "取消失败: " + err.message);
    }
  }),
);

export default router;
