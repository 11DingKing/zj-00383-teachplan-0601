import { Router, Request, Response } from "express";
import db from "../db/database";
import {
  sendResponse,
  sendError,
  handleAsync,
  calcAttendanceRate,
  hasSufficientAttendance,
  MIN_REQUIRED_ATTENDANCE_RATE,
} from "../utils/helpers";

const router = Router();

router.get(
  "/overview",
  handleAsync(async (req: Request, res: Response) => {
    const { start_date, end_date } = req.query as any;

    const dateConditions: string[] = [];
    const dateParams: any[] = [];
    if (start_date) {
      dateConditions.push("tc.created_at >= ?");
      dateParams.push(start_date);
    }
    if (end_date) {
      dateConditions.push("tc.created_at <= ?");
      dateParams.push(end_date + " 23:59:59");
    }
    const dateWhere =
      dateConditions.length > 0 ? "WHERE " + dateConditions.join(" AND ") : "";

    const classCondParams = [...dateParams];
    const classDateWhere =
      dateConditions.length > 0 ? "AND " + dateConditions.join(" AND ") : "";

    const totalClasses = (
      db
        .prepare(`SELECT COUNT(*) as c FROM training_classes tc ${dateWhere}`)
        .get(...dateParams) as any
    ).c;

    const statusBreakdown = db
      .prepare(
        `
    SELECT status, COUNT(*) as count FROM training_classes tc
    ${dateWhere}
    GROUP BY status
  `,
      )
      .all(...dateParams);

    const totalEnrollments = (
      db
        .prepare(
          `
    SELECT COUNT(*) as c FROM registrations r
    JOIN training_classes tc ON r.class_id = tc.id
    WHERE r.status = 'enrolled' ${classDateWhere.replace(/tc\./g, "tc.")}
  `,
        )
        .get(...classCondParams) as any
    ).c;

    const allExams = db
      .prepare(
        `
    SELECT ge.*, tc.id as real_class_id FROM graduation_exams ge
    JOIN training_classes tc ON ge.class_id = tc.id
    WHERE ge.result != 'pending' ${classDateWhere.replace(/tc\./g, "tc.")}
  `,
      )
      .all(...classCondParams) as any[];

    const eligibleExams = allExams.filter((e) =>
      hasSufficientAttendance(e.class_id, e.housekeeper_id),
    );
    const totalExamined = eligibleExams.length;
    const totalPassed = eligibleExams.filter(
      (e) => e.result === "passed",
    ).length;

    const skillRecordsCount = (
      db
        .prepare(
          `
    SELECT COUNT(*) as c FROM skill_records sr
    JOIN training_classes tc ON sr.class_id = tc.id
    ${dateWhere.replace("tc.", "tc.")}
  `,
        )
        .get(...dateParams) as any
    ).c;

    const totalTrainingHours = (
      db
        .prepare(
          `
    SELECT COALESCE(SUM(tc.total_hours * (
      SELECT COUNT(*) FROM registrations r WHERE r.class_id = tc.id AND r.status = 'enrolled'
    )), 0) as total
    FROM training_classes tc ${dateWhere}
  `,
        )
        .get(...dateParams) as any
    ).total;

    const uniqueHousekeepers = (
      db
        .prepare(
          `
    SELECT COUNT(DISTINCT housekeeper_id) as c
    FROM registrations r
    JOIN training_classes tc ON r.class_id = tc.id
    WHERE r.status = 'enrolled' ${classDateWhere.replace(/tc\./g, "tc.")}
  `,
        )
        .get(...classCondParams) as any
    ).c;

    const avgHoursPerPerson =
      uniqueHousekeepers > 0
        ? Math.round((totalTrainingHours / uniqueHousekeepers) * 100) / 100
        : 0;

    const overallPassRate =
      totalExamined > 0
        ? Math.round((totalPassed / totalExamined) * 10000) / 100
        : 0;

    sendResponse(res, true, "获取统计概览成功", {
      period: { start_date: start_date || null, end_date: end_date || null },
      total_classes: totalClasses,
      status_breakdown: statusBreakdown,
      total_enrollments: totalEnrollments,
      unique_trainees: uniqueHousekeepers,
      total_examined: totalExamined,
      total_passed: totalPassed,
      pass_rate: overallPassRate,
      skill_records_created: skillRecordsCount,
      total_training_hours: totalTrainingHours,
      avg_hours_per_person: avgHoursPerPerson,
      min_required_attendance_rate: MIN_REQUIRED_ATTENDANCE_RATE,
      pass_rate_note: "通过率仅统计出勤率达标学员",
    });
  }),
);

router.get(
  "/by-training-type",
  handleAsync(async (req: Request, res: Response) => {
    const { start_date, end_date } = req.query as any;

    const dateConditions: string[] = [];
    const dateParams: any[] = [];
    if (start_date) {
      dateConditions.push("tc.created_at >= ?");
      dateParams.push(start_date);
    }
    if (end_date) {
      dateConditions.push("tc.created_at <= ?");
      dateParams.push(end_date + " 23:59:59");
    }
    const dateWhere =
      dateConditions.length > 0 ? "WHERE " + dateConditions.join(" AND ") : "";

    const rawRows = db
      .prepare(
        `
    SELECT
      tt.id as training_type_id,
      tt.name as training_type_name,
      COUNT(DISTINCT tc.id) as class_count,
      COALESCE(SUM(CASE WHEN r.status = 'enrolled' THEN 1 ELSE 0 END), 0) as enrollment_count,
      COALESCE(SUM(tc.total_hours), 0) as total_class_hours,
      COALESCE(SUM(CASE WHEN r.status = 'enrolled' THEN tc.total_hours ELSE 0 END), 0) as total_person_hours,
      COUNT(DISTINCT CASE WHEN r.status = 'enrolled' THEN r.housekeeper_id ELSE NULL END) as unique_trainees,
      ge.class_id as exam_class_id,
      ge.housekeeper_id as exam_housekeeper_id,
      ge.result as exam_result
    FROM training_types tt
    LEFT JOIN training_classes tc ON tc.training_type_id = tt.id
      ${dateConditions.length > 0 ? "AND " + dateConditions.map((c) => c.replace("tc.", "tc.")).join(" AND ") : ""}
    LEFT JOIN registrations r ON r.class_id = tc.id
    LEFT JOIN graduation_exams ge ON ge.class_id = tc.id AND ge.housekeeper_id = r.housekeeper_id
    GROUP BY tt.id, tt.name, ge.class_id, ge.housekeeper_id, ge.result
    ORDER BY class_count DESC
  `,
      )
      .all(...dateParams);

    const agg: Map<string, any> = new Map();
    for (const row of rawRows as any[]) {
      const key = row.training_type_id;
      if (!agg.has(key)) {
        agg.set(key, {
          training_type_id: row.training_type_id,
          training_type_name: row.training_type_name,
          class_count: row.class_count,
          enrollment_count: row.enrollment_count,
          total_class_hours: row.total_class_hours,
          total_person_hours: row.total_person_hours,
          unique_trainees: row.unique_trainees,
          _examined: new Set(),
          _passed: new Set(),
        });
      }
      const entry = agg.get(key)!;
      if (
        row.exam_class_id &&
        row.exam_housekeeper_id &&
        row.exam_result &&
        row.exam_result !== "pending"
      ) {
        const eligible = hasSufficientAttendance(
          row.exam_class_id,
          row.exam_housekeeper_id,
        );
        if (eligible) {
          const personKey = `${row.exam_class_id}-${row.exam_housekeeper_id}`;
          entry._examined.add(personKey);
          if (row.exam_result === "passed") {
            entry._passed.add(personKey);
          }
        }
      }
    }

    const result = Array.from(agg.values()).map((r: any) => {
      const passed_count = r._passed.size;
      const examined_count = r._examined.size;
      delete r._examined;
      delete r._passed;
      return {
        ...r,
        passed_count,
        examined_count,
        avg_hours_per_person:
          r.unique_trainees > 0
            ? Math.round((r.total_person_hours / r.unique_trainees) * 100) / 100
            : 0,
        pass_rate:
          examined_count > 0
            ? Math.round((passed_count / examined_count) * 10000) / 100
            : 0,
        min_required_attendance_rate: MIN_REQUIRED_ATTENDANCE_RATE,
        pass_rate_note: "通过率仅统计出勤率达标学员",
      };
    });

    sendResponse(res, true, "按培训类型统计成功", result);
  }),
);

router.get(
  "/room-utilization",
  handleAsync(async (req: Request, res: Response) => {
    const { start_date, end_date } = req.query as any;

    const sd =
      start_date ||
      new Date(new Date().setDate(new Date().getDate() - 30))
        .toISOString()
        .slice(0, 10);
    const ed = end_date || new Date().toISOString().slice(0, 10);

    const start = new Date(sd);
    const end = new Date(ed);
    const totalDays = Math.max(
      1,
      Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1,
    );
    const HOURS_PER_DAY = 8;
    const totalAvailableHoursPerRoom = totalDays * HOURS_PER_DAY;

    const rooms = db
      .prepare("SELECT id, name, capacity FROM training_rooms ORDER BY name")
      .all() as any[];

    const result = rooms.map((room: any) => {
      const schedules = db
        .prepare(
          `
      SELECT cs.date, cs.start_time, cs.end_time
      FROM class_schedules cs
      JOIN training_classes tc ON cs.class_id = tc.id
      WHERE tc.room_id = ? AND cs.date BETWEEN ? AND ?
        AND tc.status != 'enrolling'
    `,
        )
        .all(room.id, sd, ed);

      const allSchedules = db
        .prepare(
          `
      SELECT cs.date, cs.start_time, cs.end_time, tc.status
      FROM class_schedules cs
      JOIN training_classes tc ON cs.class_id = tc.id
      WHERE tc.room_id = ? AND cs.date BETWEEN ? AND ?
    `,
        )
        .all(room.id, sd, ed);

      let usedMinutes = 0;
      for (const s of schedules as any[]) {
        const [sh, sm] = s.start_time.split(":").map(Number);
        const [eh, em] = s.end_time.split(":").map(Number);
        usedMinutes += eh * 60 + em - (sh * 60 + sm);
      }
      const usedHours = Math.round((usedMinutes / 60) * 100) / 100;
      const utilization =
        totalAvailableHoursPerRoom > 0
          ? Math.round((usedHours / totalAvailableHoursPerRoom) * 10000) / 100
          : 0;

      return {
        room_id: room.id,
        room_name: room.name,
        capacity: room.capacity,
        period: { start_date: sd, end_date: ed, total_days: totalDays },
        available_hours: totalAvailableHoursPerRoom,
        scheduled_hours: usedHours,
        schedule_count: schedules.length,
        total_schedule_count: allSchedules.length,
        excluded_enrolling_count: allSchedules.length - schedules.length,
        utilization_rate: Math.min(100, utilization),
        utilization_note: "使用率仅统计已开班/培训中/已结业班级",
      };
    });

    const totalAvailable = result.reduce((s, r) => s + r.available_hours, 0);
    const totalUsed = result.reduce((s, r) => s + r.scheduled_hours, 0);
    const overall =
      totalAvailable > 0
        ? Math.round((totalUsed / totalAvailable) * 10000) / 100
        : 0;

    sendResponse(res, true, "培训室使用率统计成功", {
      summary: {
        period: { start_date: sd, end_date: ed },
        total_rooms: rooms.length,
        total_available_hours: totalAvailable,
        total_scheduled_hours: totalUsed,
        overall_utilization_rate: Math.min(100, overall),
      },
      details: result,
    });
  }),
);

router.get(
  "/instructor-workload",
  handleAsync(async (req: Request, res: Response) => {
    const { start_date, end_date } = req.query as any;

    const dateConditions: string[] = [];
    const dateParams: any[] = [];
    if (start_date) {
      dateConditions.push("tc.created_at >= ?");
      dateParams.push(start_date);
    }
    if (end_date) {
      dateConditions.push("tc.created_at <= ?");
      dateParams.push(end_date + " 23:59:59");
    }
    const andWhere =
      dateConditions.length > 0
        ? "AND " +
          dateConditions.map((c) => c.replace("tc.", "tc.")).join(" AND ")
        : "";

    const rows = db
      .prepare(
        `
    SELECT
      i.id as instructor_id,
      i.name as instructor_name,
      i.specialty,
      COUNT(DISTINCT tc.id) as class_count,
      COALESCE(SUM(tc.total_hours), 0) as total_hours,
      COUNT(DISTINCT CASE WHEN r.status = 'enrolled' THEN r.housekeeper_id ELSE NULL END) as total_trainees
    FROM instructors i
    LEFT JOIN training_classes tc ON tc.instructor_id = i.id ${andWhere}
    LEFT JOIN registrations r ON r.class_id = tc.id AND r.status = 'enrolled'
    GROUP BY i.id, i.name, i.specialty
    ORDER BY total_hours DESC
  `,
      )
      .all(...dateParams);

    sendResponse(res, true, "讲师工作量统计成功", rows);
  }),
);

router.get(
  "/monthly-trend",
  handleAsync(async (req: Request, res: Response) => {
    const months = 12;
    const result: any[] = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const monthKey = `${y}-${String(m).padStart(2, "0")}`;
      const monthStart = `${monthKey}-01`;
      const nextMonth = new Date(y, m, 1);
      const monthEnd = new Date(nextMonth.getTime() - 1)
        .toISOString()
        .slice(0, 10);

      const classCount = (
        db
          .prepare(
            `
      SELECT COUNT(*) as c FROM training_classes
      WHERE created_at BETWEEN ? AND ? || ' 23:59:59'
    `,
          )
          .get(monthStart, monthEnd) as any
      ).c;

      const enrollmentCount = (
        db
          .prepare(
            `
      SELECT COUNT(*) as c FROM registrations r
      WHERE r.status = 'enrolled' AND r.registered_at BETWEEN ? AND ? || ' 23:59:59'
    `,
          )
          .get(monthStart, monthEnd) as any
      ).c;

      const certCount = (
        db
          .prepare(
            `
      SELECT COUNT(*) as c FROM skill_records
      WHERE recorded_at BETWEEN ? AND ? || ' 23:59:59'
    `,
          )
          .get(monthStart, monthEnd) as any
      ).c;

      result.push({
        month: monthKey,
        class_count: classCount,
        enrollment_count: enrollmentCount,
        certificate_count: certCount,
      });
    }

    sendResponse(res, true, "月度趋势统计成功", result);
  }),
);

export default router;
