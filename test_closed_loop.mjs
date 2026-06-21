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

function pad(n, len = 4) {
  return String(n).padStart(len, "0");
}

(async () => {
  try {
    console.log("====== 培训闭环系统功能测试 ======\n");

    const types = (await api("GET", "/training-types/all")).data;
    const rooms = (await api("GET", "/training-rooms/all")).data;
    const insts = (await api("GET", "/instructors/all")).data;

    let TYPE_ID, ROOM_ID, INST_ID;
    if (types.length === 0) {
      const t = await api("POST", "/training-types", {
        name: "家政服务基础",
        description: "基础培训",
        default_duration_hours: 40,
      });
      TYPE_ID = t.data.id;
    } else TYPE_ID = types[0].id;
    if (rooms.length === 0) {
      const r = await api("POST", "/training-rooms", {
        name: "培训室A",
        location: "1楼",
        capacity: 20,
      });
      ROOM_ID = r.data.id;
    } else ROOM_ID = rooms[0].id;
    if (insts.length === 0) {
      const i = await api("POST", "/instructors", {
        name: "张老师",
        phone: "13800000001",
        specialty: "家政服务",
      });
      INST_ID = i.data.id;
    } else INST_ID = insts[0].id;

    console.log("✓ 基础数据就绪");

    console.log("\n====== 1. 创建4名家政人员 ======");
    const rand = Math.floor(Math.random() * 9000) + 1000;
    const names = [
      { name: "李秀英", id_card: `1101011980${pad(rand)}01`, phone: `139${pad(1000 + rand, 8)}` },
      { name: "王桂芳", id_card: `1101011980${pad(rand + 1)}02`, phone: `139${pad(2000 + rand, 8)}` },
      { name: "赵美娟", id_card: `1101011980${pad(rand + 2)}03`, phone: `139${pad(3000 + rand, 8)}` },
      { name: "钱翠花", id_card: `1101011980${pad(rand + 3)}04`, phone: `139${pad(4000 + rand, 8)}` },
    ];
    const hks = [];
    for (const n of names) {
      const h = await api("POST", "/housekeepers", {
        name: n.name,
        id_card: n.id_card,
        phone: n.phone,
        gender: "female",
      });
      if (!h.success) {
        console.error("创建家政人员失败:", h.message);
        process.exit(1);
      }
      hks.push(h.data);
    }
    console.log("  ✓ 创建:", hks.map((h) => h.name).join("、"));

    console.log("\n====== 2. 创建容量=3的培训班（4节课） ======");
    const cls = await api("POST", "/training-classes", {
      training_type_id: TYPE_ID,
      name: "家政基础班闭环测试" + rand,
      instructor_id: INST_ID,
      room_id: ROOM_ID,
      capacity: 3,
      start_date: "2026-07-01",
      end_date: "2026-07-10",
      total_hours: 32,
      schedules: [
        { date: "2026-07-01", start_time: "09:00", end_time: "12:00", content: "家政礼仪" },
        { date: "2026-07-02", start_time: "09:00", end_time: "12:00", content: "保洁实操" },
        { date: "2026-07-03", start_time: "09:00", end_time: "12:00", content: "烹饪基础" },
        { date: "2026-07-04", start_time: "09:00", end_time: "12:00", content: "应急处置" },
      ],
    });
    if (!cls.success) {
      console.error("创建班级失败:", cls.message);
      process.exit(1);
    }
    const CLASS_ID = cls.data.id;
    const clsDetail = await api("GET", "/training-classes/" + CLASS_ID);
    if (!clsDetail.success) {
      console.error("获取班级详情失败:", clsDetail.message);
      process.exit(1);
    }
    const SCHEDS = clsDetail.data.schedules;
    console.log("  ✓ 班级创建成功, 课程数:", SCHEDS.length);

    console.log("\n====== 3. 4人报名（3人正选，1人候补） ======");
    for (let i = 0; i < 4; i++) {
      const r = await api("POST", "/registrations", {
        class_id: CLASS_ID,
        housekeeper_id: hks[i].id,
      });
      console.log(
        `  ${hks[i].name}: ${r.message} [${r.data.status}]${r.data.wait_position ? " 候补#" + r.data.wait_position : ""}`,
      );
    }

    console.log("\n====== 4. 取消李秀英报名 → 钱翠花候补转正 ======");
    const regList = (await api("GET", "/registrations?class_id=" + CLASS_ID))
      .data.items;
    const liId = regList.find((r) => r.housekeeper_id === hks[0].id).id;
    const cancel = await api("DELETE", "/registrations/" + liId + "/cancel");
    console.log("  " + cancel.message);
    if (cancel.data.promoted_waiter) {
      const pw = cancel.data.promoted_waiter;
      console.log(
        `  ✓ 转正学员: ${pw.housekeeper_name}, 课程安排数: ${pw.schedules.length}`,
      );
    }

    console.log("\n====== 5. 开班 → 培训中 ======");
    await api("POST", "/training-classes/" + CLASS_ID + "/start");
    await api("POST", "/training-classes/" + CLASS_ID + "/begin-training");
    console.log("  ✓ 班级进入培训中状态");

    console.log("\n====== 6. 录入考勤（王桂芳缺第2节课，其他全勤） ======");
    for (let i = 0; i < SCHEDS.length; i++) {
      await api("POST", "/attendances/batch", {
        schedule_id: SCHEDS[i].id,
        records: [
          {
            housekeeper_id: hks[1].id,
            status: i === 1 ? "absent" : "present",
          },
          { housekeeper_id: hks[2].id, status: "present" },
          { housekeeper_id: hks[3].id, status: "present" },
        ],
      });
    }
    const attSummary = (
      await api("GET", "/attendances/class/" + CLASS_ID + "/summary")
    ).data;
    attSummary.forEach((a) =>
      console.log(
        `  ${a.housekeeper_name}: 出勤${a.present} 缺勤${a.absent} 补课${a.makeup_count} 出勤率${a.attendance_rate}%`,
      ),
    );

    console.log("\n====== 7. 查询缺勤列表 ======");
    const absentList = (
      await api("GET", "/attendances/class/" + CLASS_ID + "/absent-list")
    ).data;
    console.log("  缺勤记录数:", absentList.total);
    absentList.items.forEach((a) => {
      console.log(
        `  - ${a.housekeeper_name} @ ${a.schedule_date} ${a.schedule_content} → 已安排补课: ${a.makeup_scheduled}`,
      );
    });

    console.log("\n====== 8. 为王桂芳创建补课安排 ======");
    const absentItem = absentList.items[0];
    const makeupSched = await api("POST", "/attendances/makeup/schedule", {
      class_id: CLASS_ID,
      original_schedule_id: absentItem.schedule_id,
      date: "2026-07-08",
      start_time: "14:00",
      end_time: "17:00",
      content: "保洁实操（补课）",
      room_id: ROOM_ID,
      instructor_id: INST_ID,
    });
    if (!makeupSched.success) {
      console.error("创建补课安排失败:", makeupSched.message);
      process.exit(1);
    }
    const MAKEUP_SCHED_ID = makeupSched.data.id;
    console.log(
      `  ✓ 补课安排创建: ${makeupSched.data.date} ${makeupSched.data.start_time}-${makeupSched.data.end_time}`,
    );

    console.log("\n====== 9. 登记王桂芳补课 ======");
    await api("POST", "/attendances/makeup/register", {
      makeup_schedule_id: MAKEUP_SCHED_ID,
      housekeeper_ids: [hks[1].id],
    });
    console.log("  ✓ 补课登记成功");

    console.log("\n====== 10. 录入补课考勤（王桂芳出勤） ======");
    await api("POST", "/attendances/makeup/attendance", {
      makeup_schedule_id: MAKEUP_SCHED_ID,
      records: [{ housekeeper_id: hks[1].id, status: "present" }],
    });
    console.log("  ✓ 补课考勤录入成功");

    console.log("\n====== 11. 再次查看出勤率（王桂芳补课后视作出勤） ======");
    const attSummary2 = (
      await api("GET", "/attendances/class/" + CLASS_ID + "/summary")
    ).data;
    attSummary2.forEach((a) =>
      console.log(
        `  ${a.housekeeper_name}: 出勤${a.present} 缺勤${a.absent} 补课${a.makeup_count} 出勤率${a.attendance_rate}%`,
      ),
    );

    console.log("\n====== 12. 结业考核（赵美娟首次不及格） ======");
    const ex1 = await api("POST", "/graduation/exam", {
      class_id: CLASS_ID,
      housekeeper_id: hks[1].id,
      exam_date: "2026-07-10",
      score: 82,
      examined_by: "张老师",
    });
    const exZhao1 = await api("POST", "/graduation/exam", {
      class_id: CLASS_ID,
      housekeeper_id: hks[2].id,
      exam_date: "2026-07-10",
      score: 50,
      examined_by: "张老师",
    });
    const ex3 = await api("POST", "/graduation/exam", {
      class_id: CLASS_ID,
      housekeeper_id: hks[3].id,
      exam_date: "2026-07-10",
      score: 75,
      examined_by: "张老师",
    });
    console.log(`  王桂芳 82分 → ${ex1.message}`);
    console.log(`  赵美娟 50分 → ${exZhao1.message}`);
    console.log(`  钱翠花 75分 → ${ex3.message}`);

    console.log("\n====== 13. 查看补考名单 ======");
    const failed = (
      await api("GET", "/graduation/class/" + CLASS_ID + "/failed-list")
    ).data;
    console.log("  补考名单人数:", failed.total);
    failed.items.forEach((f) =>
      console.log(`  - ${f.housekeeper_name}: ${f.score}分`),
    );

    console.log("\n====== 14. 赵美娟补考（70分通过） ======");
    const exZhao2 = await api("POST", "/graduation/exam", {
      class_id: CLASS_ID,
      housekeeper_id: hks[2].id,
      exam_date: "2026-07-12",
      score: 70,
      examined_by: "张老师",
      is_retake: true,
    });
    console.log(
      `  ${exZhao2.message}, 补考次数: ${exZhao2.data.retake_count}, 是否补考: ${exZhao2.data.is_retake}`,
    );

    console.log("\n====== 15. 班级结业 ======");
    const grad = await api(
      "POST",
      "/graduation/class/" + CLASS_ID + "/complete",
    );
    if (!grad.success) {
      console.error("结业失败:", grad.message);
      process.exit(1);
    }
    const s = grad.data.summary;
    console.log("  " + grad.message);
    console.log(
      `  总报名=${s.total_enrolled}, 通过=${s.passed_count}, 通过率=${s.pass_rate}%`,
    );
    console.log(
      `  补课统计: ${s.makeup_stats.had_makeup}人补课, 补课率=${s.makeup_stats.makeup_rate}%`,
    );
    console.log(
      `  补考统计: ${s.retake_stats.had_retake}人补考, 通过率=${s.retake_stats.retake_pass_rate}%`,
    );
    console.log(
      `  候补转正: ${s.promoted_from_waiting_stats.count}人`,
    );
    console.log(`  最终结业率: ${s.final_graduation_rate}%`);
    console.log("\n  技能档案明细:");
    grad.data.skill_records.forEach((sr) => {
      console.log(
        `    - ${sr.housekeeper_name}: 证书=${sr.certificate_no} 分数=${sr.score} 出勤率=${sr.attendance_rate}% 补课=${sr.makeup_count}次 补考=${sr.retake_count}次 候补转正=${sr.was_waiting_promoted ? "是" : "否"}`,
      );
    });

    console.log("\n====== 16. 统计概览（含闭环数据） ======");
    const ov = (await api("GET", "/statistics/overview")).data;
    const cs = ov.closed_loop_stats;
    console.log(
      `  总补课使用: ${cs.total_makeup_used}人, 整体补课率: ${cs.overall_makeup_rate}%`,
    );
    console.log(
      `  含补课档案: ${cs.skill_records_with_makeup}, 含补考档案: ${cs.skill_records_with_retake}`,
    );
    console.log(
      `  候补转正档案: ${cs.skill_records_promoted_from_waiting}`,
    );
    console.log(
      `  补考通过: ${cs.total_retakes_passed}人, 补考通过率: ${cs.retake_pass_rate}%`,
    );
    console.log(`  最终结业率: ${cs.final_graduation_rate}%`);

    console.log("\n====== 17. 按培训类型统计 ======");
    const bt = (await api("GET", "/statistics/by-training-type")).data;
    bt.forEach((r) => {
      console.log(`  ${r.training_type_name}:`);
      console.log(
        `    通过率=${r.pass_rate}%, 补课率=${r.makeup_stats.makeup_rate}%, 补考通过率=${r.retake_stats.retake_pass_rate}%, 最终结业率=${r.final_graduation_stats.final_graduation_rate}%`,
      );
    });

    console.log("\n✅ 培训闭环功能全部测试通过!");
    process.exit(0);
  } catch (e) {
    console.error("✗ 测试异常:", e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
