import { Router, Request, Response } from "express";
import db from "../db/database";
import {
  generateId,
  sendResponse,
  sendError,
  handleAsync,
  calcAttendanceRate,
  hasSufficientAttendance,
  MIN_REQUIRED_ATTENDANCE_RATE,
  getScheduleCount,
  getMakeupCount,
  hasMakeup,
  getRetakeCount,
  hasRetake,
  isWaitingPromoted,
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

router.post(
  "/exam",
  handleAsync(async (req: Request, res: Response) => {
    const {
      class_id,
      housekeeper_id,
      exam_date,
      score,
      examined_by,
      is_retake,
    } = req.body;
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

    const scheduleCount = getScheduleCount(class_id);
    if (scheduleCount === 0) {
      return sendError(res, "班级无课程安排，无法录入考核成绩");
    }

    const attendanceRate = calcAttendanceRate(class_id, housekeeper_id);
    const hasAttendance = hasSufficientAttendance(class_id, housekeeper_id);

    const PASS_SCORE = 60;
    let result: ExamResult = score >= PASS_SCORE ? "passed" : "failed";
    if (!hasAttendance && result === "passed") {
      result = "failed";
    }
    const certificateNo =
      result === "passed" ? generateCertificateNo() : undefined;

    const existing = db
      .prepare(
        `SELECT id, retake_count, result as prev_result FROM graduation_exams WHERE class_id = ? AND housekeeper_id = ?`,
      )
      .get(class_id, housekeeper_id) as any;

    let retakeCount = 0;
    let isRetakeFlag = 0;
    let parentExamId: string | null = null;

    if (existing) {
      if (existing.prev_result === "passed") {
        return sendError(res, "该学员已通过考核，无需补考");
      }
      retakeCount = (existing.retake_count || 0) + 1;
      isRetakeFlag = 1;
      parentExamId = existing.id;
    } else if (is_retake) {
      isRetakeFlag = 1;
      retakeCount = 1;
    }

    const tx = db.transaction(() => {
      if (existing) {
        db.prepare(
          `
        UPDATE graduation_exams SET exam_date=?, score=?, result=?, certificate_no=?, examined_by=?, is_retake=?, retake_count=?, parent_exam_id=?
        WHERE id = ?
      `,
        ).run(
          exam_date,
          score,
          result,
          certificateNo || null,
          examined_by || "",
          isRetakeFlag,
          retakeCount,
          parentExamId,
          existing.id,
        );
      } else {
        db.prepare(
          `
        INSERT INTO graduation_exams (id, class_id, housekeeper_id, exam_date, score, result, certificate_no, examined_by, is_retake, retake_count, parent_exam_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          isRetakeFlag,
          retakeCount,
          parentExamId,
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
      let msg = "";
      if (!hasAttendance && score >= PASS_SCORE) {
        msg = `考核分数达标但出勤率不足(${attendanceRate}%)，未达到最低要求${MIN_REQUIRED_ATTENDANCE_RATE}%，按不合格处理`;
      } else if (result === "passed") {
        msg = `考核${isRetakeFlag ? "补考" : ""}通过，结业证号: ${certificateNo}`;
      } else {
        msg = `考核${isRetakeFlag ? "补考" : ""}未通过`;
      }
      sendResponse(res, true, msg, {
        ...(saved as object),
        attendance_rate: attendanceRate,
        is_retake: isRetakeFlag,
        retake_count: retakeCount,
      });
    } catch (err: any) {
      sendError(res, "保存失败: " + err.message);
    }
  }),
);

router.get(
  "/class/:classId/failed-list",
  handleAsync(async (req: Request, res: Response) => {
    const { classId } = req.params;
    const failedList = db
      .prepare(
        `
    SELECT ge.*, h.name as housekeeper_name, h.phone as housekeeper_phone,
           h.id_card as housekeeper_id_card
    FROM graduation_exams ge
    LEFT JOIN housekeepers h ON ge.housekeeper_id = h.id
    WHERE ge.class_id = ? AND ge.result = 'failed'
    ORDER BY ge.score ASC
  `,
      )
      .all(classId);
    sendResponse(res, true, "获取补考名单成功", {
      total: failedList.length,
      items: failedList,
    });
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

    const scheduleCount = getScheduleCount(classId);
    if (scheduleCount === 0) {
      return sendError(res, "班级无课程安排，无法结业");
    }

    const enrolledList = db
      .prepare(
        `SELECT housekeeper_id FROM registrations WHERE class_id = ? AND status = 'enrolled'`,
      )
      .all(classId) as any[];

    const attendanceChecks = enrolledList.map((r) => {
      const rate = calcAttendanceRate(classId, r.housekeeper_id);
      const sufficient = hasSufficientAttendance(classId, r.housekeeper_id);
      return {
        housekeeper_id: r.housekeeper_id,
        attendance_rate: rate,
        sufficient,
      };
    });

    const insufficientAttendance = attendanceChecks.filter(
      (a) => !a.sufficient,
    );
    if (insufficientAttendance.length > 0) {
      const hkNames = db
        .prepare(
          `SELECT id, name FROM housekeepers WHERE id IN (${insufficientAttendance.map(() => "?").join(",")})`,
        )
        .all(...insufficientAttendance.map((a) => a.housekeeper_id)) as any[];
      const nameMap = new Map(hkNames.map((h) => [h.id, h.name]));
      const details = insufficientAttendance
        .map(
          (a) =>
            `${nameMap.get(a.housekeeper_id) || a.housekeeper_id}(${a.attendance_rate}%)`,
        )
        .join("、");
      return sendError(
        res,
        `以下学员出勤率未达到${MIN_REQUIRED_ATTENDANCE_RATE}%，无法结业：${details}`,
      );
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

    const examinedIds = new Set(exams.map((e) => e.housekeeper_id));
    const missingExam = enrolledList.filter(
      (r) => !examinedIds.has(r.housekeeper_id),
    );
    if (missingExam.length > 0) {
      const hkNames = db
        .prepare(
          `SELECT id, name FROM housekeepers WHERE id IN (${missingExam.map(() => "?").join(",")})`,
        )
        .all(...missingExam.map((r) => r.housekeeper_id)) as any[];
      const names = hkNames.map((h) => h.name).join("、");
      return sendError(res, `以下学员尚未录入考核成绩：${names}`);
    }

    const validPassed = exams.filter(
      (e) =>
        e.result === "passed" &&
        hasSufficientAttendance(classId, e.housekeeper_id),
    );

    const tx = db.transaction(() => {
      for (const exam of validPassed) {
        const existing = db
          .prepare(
            `SELECT id FROM skill_records WHERE class_id = ? AND housekeeper_id = ?`,
          )
          .get(classId, exam.housekeeper_id);
        if (existing) continue;

        const attendanceRate = calcAttendanceRate(classId, exam.housekeeper_id);
        const makeupCount = getMakeupCount(classId, exam.housekeeper_id);
        const retakeCount = getRetakeCount(classId, exam.housekeeper_id);
        const hadMakeup = hasMakeup(classId, exam.housekeeper_id) ? 1 : 0;
        const hadRetake = hasRetake(classId, exam.housekeeper_id) ? 1 : 0;
        const wasWaitingPromoted = isWaitingPromoted(
          classId,
          exam.housekeeper_id,
        )
          ? 1
          : 0;

        db.prepare(
          `
        INSERT INTO skill_records (id, housekeeper_id, class_id, training_type_id,
          certificate_no, score, start_date, end_date, total_hours, attendance_rate,
          had_makeup, had_retake, was_waiting_promoted, makeup_count, retake_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          hadMakeup,
          hadRetake,
          wasWaitingPromoted,
          makeupCount,
          retakeCount,
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

      const eligibleForExam = enrolledList.length;
      const passedCount = validPassed.length;
      const passRate =
        eligibleForExam > 0
          ? Math.round((passedCount / eligibleForExam) * 10000) / 100
          : 0;

      const makeupStats = {
        had_makeup: skillRecords.filter((s: any) => s.had_makeup === 1).length,
        total_makeup_count: skillRecords.reduce(
          (sum: number, s: any) => sum + (s.makeup_count || 0),
          0,
        ),
      };

      const allRetakeList = exams.filter(
        (e: any) => (e.is_retake || 0) === 1 || (e.retake_count || 0) > 0,
      );
      const retakePassedList = allRetakeList.filter(
        (e: any) => e.result === "passed",
      );
      const retakeStats = {
        had_retake: allRetakeList.length,
        passed_after_retake: retakePassedList.length,
        total_retake_count: allRetakeList.reduce(
          (sum: number, e: any) => sum + (e.retake_count || 0),
          0,
        ),
        retake_pass_rate:
          allRetakeList.length > 0
            ? Math.round(
                (retakePassedList.length / allRetakeList.length) * 10000,
              ) / 100
            : 0,
      };

      const promotedStats = {
        count: skillRecords.filter((s: any) => s.was_waiting_promoted === 1)
          .length,
      };

      const makeupRate =
        eligibleForExam > 0
          ? Math.round((makeupStats.had_makeup / eligibleForExam) * 10000) / 100
          : 0;
      const finalGraduationRate =
        eligibleForExam > 0
          ? Math.round((passedCount / eligibleForExam) * 10000) / 100
          : 0;

      sendResponse(
        res,
        true,
        `班级已结业，共 ${skillRecords.length} 名学员技能档案已更新`,
        {
          class_info: updatedClass,
          skill_records: skillRecords,
          summary: {
            total_enrolled: eligibleForExam,
            total_examined: exams.length,
            passed_count: passedCount,
            failed_count: exams.length - passedCount,
            pass_rate: passRate,
            min_attendance_rate: MIN_REQUIRED_ATTENDANCE_RATE,
            attendance_checks: attendanceChecks,
            makeup_stats: {
              ...makeupStats,
              makeup_rate: makeupRate,
            },
            retake_stats: retakeStats,
            promoted_from_waiting_stats: promotedStats,
            final_graduation_rate: finalGraduationRate,
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
