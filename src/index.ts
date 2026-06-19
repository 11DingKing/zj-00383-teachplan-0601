import express = require("express");
import cors = require("cors");
import * as path from "path";
import * as fs from "fs";

import trainingTypesRouter from "./routes/trainingTypes";
import trainingRoomsRouter from "./routes/trainingRooms";
import instructorsRouter from "./routes/instructors";
import housekeepersRouter from "./routes/housekeepers";
import trainingClassesRouter from "./routes/trainingClasses";
import registrationsRouter from "./routes/registrations";
import attendancesRouter from "./routes/attendances";
import graduationRouter from "./routes/graduation";
import statisticsRouter from "./routes/statistics";

import { notFoundHandler, errorHandler } from "./middleware/errorHandler";
import { sendResponse } from "./utils/helpers";

const app = express();
const PORT = parseInt(process.env.PORT || "3000");

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get("/api/health", (_req, res) => {
  sendResponse(res, true, "家政服务中心技能培训后端服务运行正常", {
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    database: "connected",
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "家政服务中心技能培训排课与结业管理系统",
    version: "1.0.0",
    description: "家政技能培训排课、报名、考勤、结业考核、技能档案管理后端API",
    endpoints: {
      base: "/api",
      docs: "请查看 README.md 了解完整接口文档",
    },
  });
});

const API_PREFIX = "/api";
app.use(`${API_PREFIX}/training-types`, trainingTypesRouter);
app.use(`${API_PREFIX}/training-rooms`, trainingRoomsRouter);
app.use(`${API_PREFIX}/instructors`, instructorsRouter);
app.use(`${API_PREFIX}/housekeepers`, housekeepersRouter);
app.use(`${API_PREFIX}/training-classes`, trainingClassesRouter);
app.use(`${API_PREFIX}/registrations`, registrationsRouter);
app.use(`${API_PREFIX}/attendances`, attendancesRouter);
app.use(`${API_PREFIX}/graduation`, graduationRouter);
app.use(`${API_PREFIX}/statistics`, statisticsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  家政技能培训后端服务已启动`);
  console.log(`  端口: ${PORT}`);
  console.log(`  健康检查: http://localhost:${PORT}/api/health`);
  console.log(
    `  数据库: ${process.env.DB_PATH || path.join(process.cwd(), "data", "training.db")}`,
  );
  console.log(`========================================\n`);
});

export default app;
