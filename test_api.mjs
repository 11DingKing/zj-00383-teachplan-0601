const BASE = "http://localhost:3000/api";

async function api(method, path, data) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(BASE + path, opts);
  return await res.json();
}

(async () => {
  try {
    const health = await api("GET", "/../api/health");
    console.log("✓ 服务健康:", health.message);

    console.log("\n====== 1. 获取基础数据 ======");
    const types = (await api("GET", "/training-types/all")).data;
    const rooms = (await api("GET", "/training-rooms/all")).data;
    const insts = (await api("GET", "/instructors/all")).data;
    const TYPE_ID = types[0].id,
      ROOM_ID = rooms[0].id,
      INST_ID = insts[0].id;
    console.log("  培训类型:", types[0].name);
    console.log("  培训室:", rooms[0].name, "容量=" + rooms[0].capacity);
    console.log("  讲师:", insts[0].name);

    console.log("\n====== 2. 创建3名家政人员 ======");
    const hk1 = (
      await api("POST", "/housekeepers", {
        name: "李秀英",
        id_card: "110101198001012222",
        phone: "13911112222",
        gender: "female",
      })
    ).data;
    const hk2 = (
      await api("POST", "/housekeepers", {
        name: "王桂芳",
        id_card: "110101198202022222",
        phone: "13911113333",
        gender: "female",
      })
    ).data;
    const hk3 = (
      await api("POST", "/housekeepers", {
        name: "赵美娟",
        id_card: "110101198503032222",
        phone: "13911114444",
        gender: "female",
      })
    ).data;
    console.log("  创建:", hk1.name, hk2.name, hk3.name);

    console.log("\n====== 3. 创建容量=2的培训班（含课表） ======");
    const cls = await api("POST", "/training-classes", {
      training_type_id: TYPE_ID,
      name: "家政基础班第1期",
      instructor_id: INST_ID,
      room_id: ROOM_ID,
      capacity: 2,
      start_date: "2026-07-01",
      end_date: "2026-07-05",
      total_hours: 20,
      schedules: [
        {
          date: "2026-07-01",
          start_time: "09:00",
          end_time: "12:00",
          content: "家政礼仪与职业规范",
        },
        {
          date: "2026-07-02",
          start_time: "09:00",
          end_time: "12:00",
          content: "保洁实操训练",
        },
        {
          date: "2026-07-03",
          start_time: "14:00",
          end_time: "17:00",
          content: "应急处置演练",
        },
      ],
    });
    console.log(
      "  结果:",
      cls.success ? "成功 班级=" + cls.data.id : "失败: " + cls.message,
    );

    console.log("\n====== 4. 冲突检测（同室同时段） ======");
    const conflict = await api("POST", "/training-classes", {
      training_type_id: TYPE_ID,
      name: "冲突测试班",
      instructor_id: INST_ID,
      room_id: ROOM_ID,
      capacity: 10,
      start_date: "2026-07-01",
      end_date: "2026-07-10",
      total_hours: 20,
      schedules: [
        {
          date: "2026-07-01",
          start_time: "10:00",
          end_time: "11:00",
          content: "冲突",
        },
      ],
    });
    console.log(
      "  冲突检测:",
      !conflict.success ? "✓ 正确拦截: " + conflict.message : "✗ 未拦截!",
    );

    const CLASS_ID = cls.data.id;
    const SCHEDS =
      cls.data.schedules ||
      (await api("GET", "/training-classes/" + CLASS_ID)).data.schedules;

    console.log("\n====== 5. 报名（容量2，第3人候补） ======");
    const r1 = await api("POST", "/registrations", {
      class_id: CLASS_ID,
      housekeeper_id: hk1.id,
    });
    console.log(
      "  " + hk1.name + ": " + r1.message + " [" + r1.data.status + "]",
    );
    const r2 = await api("POST", "/registrations", {
      class_id: CLASS_ID,
      housekeeper_id: hk2.id,
    });
    console.log(
      "  " + hk2.name + ": " + r2.message + " [" + r2.data.status + "]",
    );
    const r3 = await api("POST", "/registrations", {
      class_id: CLASS_ID,
      housekeeper_id: hk3.id,
    });
    console.log(
      "  " +
        hk3.name +
        ": " +
        r3.message +
        " [" +
        r3.data.status +
        "] 候补位=" +
        r3.data.wait_position,
    );

    console.log("\n====== 6. 取消李秀英，赵美娟应自动递补 ======");
    const regList = (await api("GET", "/registrations?class_id=" + CLASS_ID))
      .data.items;
    const r1Id = regList.find((r) => r.housekeeper_id === hk1.id).id;
    const cancel = await api("DELETE", "/registrations/" + r1Id + "/cancel");
    console.log("  " + cancel.message);
    const after = (await api("GET", "/registrations/class/" + CLASS_ID)).data;
    after.forEach((r) =>
      console.log(
        "    " +
          r.housekeeper_name +
          ": " +
          r.status +
          (r.wait_position ? " 位=" + r.wait_position : ""),
      ),
    );

    console.log("\n====== 7. 开班 (enrolling -> started) ======");
    const start = await api("POST", "/training-classes/" + CLASS_ID + "/start");
    console.log("  状态流转: " + start.message + " → " + start.data.status);

    console.log("\n====== 8. 进入培训中 (started -> in_training) ======");
    const begin = await api(
      "POST",
      "/training-classes/" + CLASS_ID + "/begin-training",
    );
    console.log("  状态流转: " + begin.message + " → " + begin.data.status);

    console.log("\n====== 9. 批量录入考勤（3节课） ======");
    for (let i = 0; i < SCHEDS.length; i++) {
      await api("POST", "/attendances/batch", {
        schedule_id: SCHEDS[i].id,
        records: [
          { housekeeper_id: hk2.id, status: i === 1 ? "absent" : "present" },
          { housekeeper_id: hk3.id, status: "present" },
        ],
      });
    }
    const att = await api("GET", "/attendances/class/" + CLASS_ID + "/summary");
    att.data.forEach((a) =>
      console.log(
        "  " +
          a.housekeeper_name +
          ": 出勤" +
          a.present +
          "/缺勤" +
          a.absent +
          " 出勤率=" +
          a.attendance_rate +
          "%",
      ),
    );

    console.log("\n====== 10. 结业考核 ======");
    const ex1 = await api("POST", "/graduation/exam", {
      class_id: CLASS_ID,
      housekeeper_id: hk2.id,
      exam_date: "2026-07-05",
      score: 85,
      examined_by: insts[0].name,
    });
    console.log("  " + hk2.name + " 85分 → " + ex1.message);
    const ex2 = await api("POST", "/graduation/exam", {
      class_id: CLASS_ID,
      housekeeper_id: hk3.id,
      exam_date: "2026-07-05",
      score: 55,
      examined_by: insts[0].name,
    });
    console.log("  " + hk3.name + " 55分 → " + ex2.message);

    console.log(
      "\n====== 11. 班级结业 (in_training -> completed + 技能档案回写) ======",
    );
    const grad = await api(
      "POST",
      "/graduation/class/" + CLASS_ID + "/complete",
    );
    const s = grad.data.summary;
    console.log("  " + grad.message);
    console.log(
      "    参考=" +
        s.total_examined +
        ", 通过=" +
        s.passed_count +
        ", 不通过=" +
        s.failed_count +
        ", 通过率=" +
        s.pass_rate +
        "%",
    );
    console.log("    技能档案回写=" + grad.data.skill_records.length + "条");
    grad.data.skill_records.forEach((sr) => {
      console.log(
        "    ✓ " +
          sr.housekeeper_name +
          " → 证书号=" +
          sr.certificate_no +
          " 分数=" +
          sr.score,
      );
    });

    console.log("\n====== 12. 查王桂芳技能档案 ======");
    const sr = await api("GET", "/housekeepers/" + hk2.id + "/skill-records");
    sr.data.forEach((r) => {
      console.log(
        "  " +
          r.class_name +
          ": 证书=" +
          r.certificate_no +
          ", 分数=" +
          r.score +
          ", 出勤率=" +
          r.attendance_rate +
          "%, 学时=" +
          r.total_hours +
          "h",
      );
    });

    console.log("\n====== 13. 验证结业证号查询 ======");
    const certNo = sr.data[0].certificate_no;
    const cert = await api("GET", "/graduation/certificate/" + certNo);
    console.log(
      "  证书查询: " +
        cert.message +
        " → " +
        cert.data.housekeeper_name +
        ", 分数=" +
        cert.data.score,
    );

    console.log("\n====== 14. 统计概览 ======");
    const ov = (await api("GET", "/statistics/overview")).data;
    console.log(
      "  班级数=" +
        ov.total_classes +
        ", 总报名=" +
        ov.total_enrollments +
        ", 培训人数=" +
        ov.unique_trainees +
        ", 总学时=" +
        ov.total_training_hours +
        ", 人均=" +
        ov.avg_hours_per_person +
        "h, 通过率=" +
        ov.pass_rate +
        "%",
    );

    console.log("\n====== 15. 按培训类型统计 ======");
    const bt = (await api("GET", "/statistics/by-training-type")).data;
    bt.forEach((r) => {
      console.log(
        "  " +
          r.training_type_name +
          ": 开班=" +
          r.class_count +
          ", 报名=" +
          r.enrollment_count +
          ", 人均=" +
          r.avg_hours_per_person +
          "h, 通过率=" +
          r.pass_rate +
          "%",
      );
    });

    console.log("\n====== 16. 培训室使用率 ======");
    const ru = (
      await api(
        "GET",
        "/statistics/room-utilization?start_date=2026-06-01&end_date=2026-07-31",
      )
    ).data;
    console.log("  整体使用率=" + ru.summary.overall_utilization_rate + "%");
    ru.details.forEach((r) => {
      console.log(
        "  " +
          r.room_name +
          ": 安排=" +
          r.scheduled_hours +
          "h, 课节=" +
          r.schedule_count +
          ", 使用率=" +
          r.utilization_rate +
          "%",
      );
    });

    console.log("\n====== 17. 讲师工作量 ======");
    const iw = (await api("GET", "/statistics/instructor-workload")).data;
    iw.forEach((r) => {
      console.log(
        "  " +
          r.instructor_name +
          ": 班级=" +
          r.class_count +
          ", 学时=" +
          r.total_hours +
          "h, 学员=" +
          r.total_trainees,
      );
    });

    console.log("\n====== 18. 近12月趋势 ======");
    const tr = (await api("GET", "/statistics/monthly-trend")).data;
    const last3 = tr.slice(-3);
    last3.forEach((m) => {
      console.log(
        "  " +
          m.month +
          ": 开班=" +
          m.class_count +
          ", 报名=" +
          m.enrollment_count +
          ", 发证=" +
          m.certificate_count,
      );
    });

    console.log("\n✅ 所有流程测试完成!");
    process.exit(0);
  } catch (e) {
    console.error("✗ 测试异常:", e.message);
    process.exit(1);
  }
})();
