import { Router, Request, Response } from "express";
import db from "../db/database";
import {
  generateId,
  sendResponse,
  sendError,
  handleAsync,
} from "../utils/helpers";
import { GraduationExam, ExamResult } from "../types";

const router = Router();

function generateCertificateNo(): string {
  const date = new Date();
  const ymd =
    date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, "0") +
    String(date.getDate()).padStart(2, "0");
  const rand = Math.floor(100000 + Math.random() * 900000).toString();
  return `HZ${ymd}${rand}`;
}

function calcAttendanceRate(classId: string, housekeeperId: string): number {
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

router.post(
  "/exam",
  handleAsync(async (req: Request, res: Response) => {
    const { class_id, housekeeper_id, exam_date, score, examined_by } =
      req.body;
    if (
      !class_id ||
      !housekeeper_id ||
      exam_date === undefined ||
      score === undefined
    ) {
      return sendError(res, "请提供班级ID、家政人员ID、考试日期和分数");
    }

    const cls = db
      .prepare("SELECT * FROM training_classes WHERE id = ?")
      .get(class_id) as any;
    if (!cls) return sendError(res, "培训班不存在", undefined, 404);
    if (!["started", "in_training"].includes(cls.status)) {
      return sendError(res, "只有已开班或培训中的班级可以录入考核成绩");
    }

    const reg = db
      .prepare(
        `
    SELECT id FROM registrations WHERE class_id = ? AND housekeeper_id = ? AND status = 'enrolled'
  `,
      )
      .get(class_id, housekeeper_id);
    if (!reg) return sendError(res, "该人员未在此班级报名或非正式学员");

    const PASS_SCORE = 60;
    const result: ExamResult = score >= PASS_SCORE ? "passed" : "failed";
    const certificateNo =
      result === "passed" ? generateCertificateNo() : undefined;

    const existing = db
      .prepare(
        `SELECT id FROM graduation_exams WHERE class_id = ? AND housekeeper_id = ?`,
      )
      .get(class_id, housekeeper_id) as any;

    const tx = db.transaction(() => {
      if (existing) {
        db.prepare(
          `
        UPDATE graduation_exams SET exam_date=?, score=?, result=?, certificate_no=?, examined_by=?
        WHERE id = ?
      `,
        ).run(
          exam_date,
          score,
          result,
          certificateNo || null,
          examined_by || "",
          existing.id,
        );
      } else {
        db.prepare(
          `
        INSERT INTO graduation_exams (id, class_id, housekeeper_id, exam_date, score, result, certificate_no, examined_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        ).run(
          generateId(),
          class_id,
          housekeeper_id,
          exam_date,
          score,
          result,
          certificateNo || null,
          examined_by || "",
        );
      }
    });

    try {
      tx();
      const saved = db
        .prepare(
          `
      SELECT ge.*, h.name as housekeeper_name, tc.name as class_name
      FROM graduation_exams ge
      LEFT JOIN housekeepers h ON ge.housekeeper_id = h.id
      LEFT JOIN training_classes tc ON ge.class_id = tc.id
      WHERE ge.class_id = ? AND ge.housekeeper_id = ?
    `,
        )
        .get(class_id, housekeeper_id);
      const msg =
        result === "passed"
          ? `考核通过，结业证号: ${certificateNo}`
          : "考核未通过";
      sendResponse(res, true, msg, saved);
    } catch (err: any) {
      sendError(res, "保存失败: " + err.message);
    }
  }),
);

router.post(
  "/class/:classId/complete",
  handleAsync(async (req: Request, res: Response) => {
    const { classId } = req.params;
    const cls = db
      .prepare("SELECT * FROM training_classes WHERE id = ?")
      .get(classId) as any;
    if (!cls) return sendError(res, "培训班不存在", undefined, 404);
    if (!["started", "in_training"].includes(cls.status)) {
      return sendError(res, "只有已开班或培训中的班级可以结业");
    }

    const exams = db
      .prepare(
        `
    SELECT * FROM graduation_exams WHERE class_id = ? AND result != 'pending'
  `,
      )
      .all(classId) as any[];
    if (exams.length === 0) {
      return sendError(res, "请先录入至少一位学员的结业考核成绩");
    }

    const passed = exams.filter((e) => e.result === "passed");

    const tx = db.transaction(() => {
      for (const exam of passed) {
        const existing = db
          .prepare(
            `SELECT id FROM skill_records WHERE class_id = ? AND housekeeper_id = ?`,
          )
          .get(classId, exam.housekeeper_id);
        if (existing) continue;

        const attendanceRate = calcAttendanceRate(classId, exam.housekeeper_id);
        db.prepare(
          `
        INSERT INTO skill_records (id, housekeeper_id, class_id, training_type_id,
          certificate_no, score, start_date, end_date, total_hours, attendance_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        ).run(
          generateId(),
          exam.housekeeper_id,
          classId,
          cls.training_type_id,
          exam.certificate_no,
          exam.score,
          cls.start_date,
          cls.end_date,
          cls.total_hours,
          attendanceRate,
        );
      }
      db.prepare(
        `UPDATE training_classes SET status = 'completed', updated_at = datetime('now') WHERE id = ?`,
      ).run(classId);
    });

    try {
      tx();
      const skillRecords = db
        .prepare(
          `
      SELECT sr.*, h.name as housekeeper_name, tt.name as training_type_name, tc.name as class_name
      FROM skill_records sr
      LEFT JOIN housekeepers h ON sr.housekeeper_id = h.id
      LEFT JOIN training_types tt ON sr.training_type_id = tt.id
      LEFT JOIN training_classes tc ON sr.class_id = tc.id
      WHERE sr.class_id = ?
      ORDER BY sr.recorded_at DESC
    `,
        )
        .all(classId);
      const updatedClass = db
        .prepare(
          `
      SELECT tc.*, tt.name as training_type_name, i.name as instructor_name, tr.name as room_name
      FROM training_classes tc
      LEFT JOIN training_types tt ON tc.training_type_id = tt.id
      LEFT JOIN instructors i ON tc.instructor_id = i.id
      LEFT JOIN training_rooms tr ON tc.room_id = tr.id
      WHERE tc.id = ?
    `,
        )
        .get(classId);

      sendResponse(
        res,
        true,
        `班级已结业，共 ${skillRecords.length} 名学员技能档案已更新`,
        {
          class_info: updatedClass,
          skill_records: skillRecords,
          summary: {
            total_examined: exams.length,
            passed_count: passed.length,
            failed_count: exams.length - passed.length,
            pass_rate: Math.round((passed.length / exams.length) * 10000) / 100,
          },
        },
      );
    } catch (err: any) {
      sendError(res, "结业操作失败: " + err.message);
    }
  }),
);

router.get(
  "/class/:classId/exams",
  handleAsync(async (req: Request, res: Response) => {
    const { classId } = req.params;
    const rows = db
      .prepare(
        `
    SELECT ge.*, h.name as housekeeper_name, h.id_card as housekeeper_id_card,
           h.phone as housekeeper_phone
    FROM graduation_exams ge
    LEFT JOIN housekeepers h ON ge.housekeeper_id = h.id
    WHERE ge.class_id = ?
    ORDER BY ge.result ASC, ge.score DESC
  `,
      )
      .all(classId);
    sendResponse(res, true, "获取成功", rows);
  }),
);

router.get(
  "/housekeeper/:housekeeperId/exams",
  handleAsync(async (req: Request, res: Response) => {
    const rows = db
      .prepare(
        `
    SELECT ge.*, tc.name as class_name, tt.name as training_type_name
    FROM graduation_exams ge
    LEFT JOIN training_classes tc ON ge.class_id = tc.id
    LEFT JOIN training_types tt ON tc.training_type_id = tt.id
    WHERE ge.housekeeper_id = ?
    ORDER BY ge.created_at DESC
  `,
      )
      .all(req.params.housekeeperId);
    sendResponse(res, true, "获取成功", rows);
  }),
);

router.get(
  "/certificate/:certificateNo",
  handleAsync(async (req: Request, res: Response) => {
    const row = db
      .prepare(
        `
    SELECT sr.*, h.name as housekeeper_name, h.id_card as housekeeper_id_card,
           tc.name as class_name, tt.name as training_type_name
    FROM skill_records sr
    LEFT JOIN housekeepers h ON sr.housekeeper_id = h.id
    LEFT JOIN training_classes tc ON sr.class_id = tc.id
    LEFT JOIN training_types tt ON sr.training_type_id = tt.id
    WHERE sr.certificate_no = ?
  `,
      )
      .get(req.params.certificateNo);
    if (!row) return sendError(res, "结业凭证不存在", undefined, 404);
    sendResponse(res, true, "查询成功", row);
  }),
);

export default router;
