import Database = require("better-sqlite3");
import * as path from "path";
import * as fs from "fs";

const DB_PATH =
  process.env.DB_PATH || path.join(process.cwd(), "data", "training.db");

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      default_duration_hours INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS training_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      location TEXT,
      capacity INTEGER NOT NULL DEFAULT 0,
      equipment TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS instructors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      specialty TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS housekeepers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      id_card TEXT UNIQUE,
      phone TEXT,
      gender TEXT CHECK(gender IN ('male', 'female')),
      birth_date TEXT,
      address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS training_classes (
      id TEXT PRIMARY KEY,
      training_type_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      instructor_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 0,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      total_hours INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'enrolling' CHECK(status IN ('enrolling', 'started', 'in_training', 'completed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (training_type_id) REFERENCES training_types(id),
      FOREIGN KEY (instructor_id) REFERENCES instructors(id),
      FOREIGN KEY (room_id) REFERENCES training_rooms(id)
    );

    CREATE TABLE IF NOT EXISTS class_schedules (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      content TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES training_classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      housekeeper_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'enrolled' CHECK(status IN ('enrolled', 'waiting', 'cancelled')),
      wait_position INTEGER,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES training_classes(id) ON DELETE CASCADE,
      FOREIGN KEY (housekeeper_id) REFERENCES housekeepers(id),
      UNIQUE(class_id, housekeeper_id)
    );

    CREATE TABLE IF NOT EXISTS attendances (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      housekeeper_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present', 'absent', 'leave')),
      remark TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES training_classes(id) ON DELETE CASCADE,
      FOREIGN KEY (schedule_id) REFERENCES class_schedules(id) ON DELETE CASCADE,
      FOREIGN KEY (housekeeper_id) REFERENCES housekeepers(id),
      UNIQUE(schedule_id, housekeeper_id)
    );

    CREATE TABLE IF NOT EXISTS graduation_exams (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      housekeeper_id TEXT NOT NULL,
      exam_date TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT 'pending' CHECK(result IN ('passed', 'failed', 'pending')),
      certificate_no TEXT UNIQUE,
      examined_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES training_classes(id) ON DELETE CASCADE,
      FOREIGN KEY (housekeeper_id) REFERENCES housekeepers(id),
      UNIQUE(class_id, housekeeper_id)
    );

    CREATE TABLE IF NOT EXISTS skill_records (
      id TEXT PRIMARY KEY,
      housekeeper_id TEXT NOT NULL,
      class_id TEXT NOT NULL,
      training_type_id TEXT NOT NULL,
      certificate_no TEXT NOT NULL UNIQUE,
      score INTEGER NOT NULL DEFAULT 0,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      total_hours INTEGER NOT NULL DEFAULT 0,
      attendance_rate REAL NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (housekeeper_id) REFERENCES housekeepers(id),
      FOREIGN KEY (class_id) REFERENCES training_classes(id),
      FOREIGN KEY (training_type_id) REFERENCES training_types(id)
    );

    CREATE INDEX IF NOT EXISTS idx_classes_type ON training_classes(training_type_id);
    CREATE INDEX IF NOT EXISTS idx_classes_status ON training_classes(status);
    CREATE INDEX IF NOT EXISTS idx_classes_room ON training_classes(room_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_class ON class_schedules(class_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_datetime ON class_schedules(date, start_time);
    CREATE INDEX IF NOT EXISTS idx_registrations_class ON registrations(class_id);
    CREATE INDEX IF NOT EXISTS idx_registrations_housekeeper ON registrations(housekeeper_id);
    CREATE INDEX IF NOT EXISTS idx_attendances_schedule ON attendances(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_skill_records_housekeeper ON skill_records(housekeeper_id);
  `);
}

initializeDatabase();

export default db;
