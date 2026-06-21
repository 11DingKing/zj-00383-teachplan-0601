export type ClassStatus = "enrolling" | "started" | "in_training" | "completed";

export type RegistrationStatus = "enrolled" | "waiting" | "cancelled";

export type AttendanceStatus = "present" | "absent" | "leave";

export type ExamResult = "passed" | "failed" | "pending";

export type MakeupScheduleStatus = "scheduled" | "completed" | "cancelled";

export interface TrainingType {
  id: string;
  name: string;
  description: string;
  default_duration_hours: number;
  created_at: string;
}

export interface TrainingRoom {
  id: string;
  name: string;
  location: string;
  capacity: number;
  equipment: string;
  created_at: string;
}

export interface Instructor {
  id: string;
  name: string;
  phone: string;
  specialty: string;
  created_at: string;
}

export interface Housekeeper {
  id: string;
  name: string;
  id_card: string;
  phone: string;
  gender: "male" | "female";
  birth_date: string;
  address: string;
  created_at: string;
}

export interface TrainingClass {
  id: string;
  training_type_id: string;
  training_type_name?: string;
  name: string;
  description: string;
  instructor_id: string;
  instructor_name?: string;
  room_id: string;
  room_name?: string;
  capacity: number;
  enrolled_count?: number;
  waiting_count?: number;
  start_date: string;
  end_date: string;
  total_hours: number;
  status: ClassStatus;
  created_at: string;
  updated_at: string;
}

export interface ClassSchedule {
  id: string;
  class_id: string;
  date: string;
  start_time: string;
  end_time: string;
  content: string;
  room_id?: string;
  room_name?: string;
  created_at: string;
}

export interface MakeupSchedule {
  id: string;
  class_id: string;
  original_schedule_id: string;
  original_schedule_content?: string;
  date: string;
  start_time: string;
  end_time: string;
  content: string;
  room_id?: string;
  room_name?: string;
  instructor_id?: string;
  instructor_name?: string;
  created_by?: string;
  created_at: string;
}

export interface MakeupRegistration {
  id: string;
  makeup_schedule_id: string;
  housekeeper_id: string;
  housekeeper_name?: string;
  original_schedule_id: string;
  class_id: string;
  status: MakeupScheduleStatus;
  registered_at: string;
}

export interface Registration {
  id: string;
  class_id: string;
  class_name?: string;
  housekeeper_id: string;
  housekeeper_name?: string;
  status: RegistrationStatus;
  wait_position?: number;
  promoted_at?: string;
  registered_at: string;
}

export interface Attendance {
  id: string;
  class_id: string;
  schedule_id: string;
  housekeeper_id: string;
  housekeeper_name?: string;
  status: AttendanceStatus;
  remark: string;
  is_makeup?: number;
  original_schedule_id?: string;
  makeup_schedule_id?: string;
  recorded_at: string;
}

export interface GraduationExam {
  id: string;
  class_id: string;
  housekeeper_id: string;
  housekeeper_name?: string;
  exam_date: string;
  score: number;
  result: ExamResult;
  certificate_no?: string;
  examined_by: string;
  is_retake?: number;
  retake_count?: number;
  parent_exam_id?: string;
  created_at: string;
}

export interface SkillRecord {
  id: string;
  housekeeper_id: string;
  class_id: string;
  class_name?: string;
  training_type_id: string;
  training_type_name?: string;
  certificate_no: string;
  score: number;
  start_date: string;
  end_date: string;
  total_hours: number;
  attendance_rate: number;
  had_makeup?: number;
  had_retake?: number;
  was_waiting_promoted?: number;
  makeup_count?: number;
  retake_count?: number;
  recorded_at: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
  errors?: string[];
}

export interface PaginationParams {
  page?: number;
  pageSize?: number;
}

export interface PaginationResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
